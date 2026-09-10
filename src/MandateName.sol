// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Context } from "@1inch/swap-vm/src/libs/VM.sol";
import { Opcode } from "@1inch/swap-vm/src/libs/OpcodeList.sol";
import { MemoryPtr, MemoryPtrLib } from "@1inch/swap-vm/src/libs/MemoryPtr.sol";
import { InstructionBuilder } from "@1inch/swap-vm/src/libs/InstructionBuilder.sol";
import { InstructionArgs } from "@1inch/swap-vm/src/libs/InstructionArgs.sol";

/// @notice The minimum an ENSv2 registry has to answer for a name to gate a settlement.
/// @dev Deliberately three functions rather than the registry's whole surface. `findTokenId` is
///   why: the token id is the labelhash with its low 32 bits cleared, and those hold a version
///   counter the registry bumps on re-registration. Deriving the id here would ask about a token
///   that does not exist, and a registry answers that with the zero address — which reads as
///   *revoked* rather than as a wrong question. The registry knows the number; we ask it.
interface IMandateNameRegistry {
    function findExpiry(string calldata label) external view returns (uint64);
    function findTokenId(string calldata label) external view returns (uint256);
    function ownerOf(uint256 tokenId) external view returns (address);
}

/// @title MandateName
/// @notice A SwapVM instruction that refuses to settle unless a name is still held by its grantee.
/// @dev Encoding: [address registry][address holder][uint8 labelLength][label bytes]
///
/// The gap this closes was documented before it was filled. An ENSv2 subname already expressed the
/// agent's authority — expiring, revocable, soulbound — and the agent consulted it before acting.
/// But nothing on chain did. Revoking the name stopped *this* agent because this agent asks; a
/// second copy of it that skipped the check, or any ordinary taker arriving at a position that was
/// still shipped, was never stopped by the name at all. The maker's real on-chain controls were the
/// expiry and `Aqua.dock()`, and the name was a control over the operator rather than over the
/// money.
///
/// With this instruction in the program, revocation binds every caller: the settlement itself asks
/// the registry, and a burned or lapsed name reverts the swap before any token moves. The maker
/// gets a kill switch that costs one transaction and needs no cooperation from the thing it stops.
///
/// It is a sequential guard rather than a wrapping one, and that is correct here: unlike a size cap
/// or a floor, the answer does not depend on the settled amounts, so there is nothing for a later
/// instruction to undo. Placed inside `PolicyEnvelope` it runs inside that frame like everything
/// else.
library MandateName {
    using InstructionArgs for bytes;
    using InstructionArgs for bytes32;
    using MemoryPtrLib for MemoryPtr;
    using InstructionBuilder for MemoryPtr;

    error MandateNameLapsed(uint64 expiry, uint256 nowTs);
    error MandateNameNotHeld(address owner, address holder);
    error MandateNameArgsTruncated(uint256 length);

    Opcode constant opcode = Opcode._22;

    /// @dev registry + holder + one length byte, before the label itself.
    uint256 internal constant HEADER = 41;

    function sizeOf(string memory label) internal pure returns (uint256) {
        return InstructionBuilder.sizeOf() + HEADER + bytes(label).length;
    }

    function build(address registry, address holder, string memory label) internal pure returns (bytes memory) {
        return build(MemoryPtrLib.alloc(sizeOf(label)), registry, holder, label).resolve();
    }

    /// @dev Streaming form, so a whole program can be laid out in one allocation.
    function build(MemoryPtr ptrStart, address registry, address holder, string memory label)
        internal
        pure
        returns (MemoryPtr ptr)
    {
        bytes memory raw = bytes(label);
        // One byte holds the length, so a label longer than 255 cannot be expressed. Refusing beats
        // truncating: a program carrying half a label asks about a different name, and a different
        // name is a different grant.
        require(raw.length <= type(uint8).max, MandateNameArgsTruncated(raw.length));

        ptr = ptrStart.pushHeader(opcode);
        ptr = ptr.push(registry);
        ptr = ptr.push(holder);
        ptr = ptr.push(uint8(raw.length));
        ptr = ptr.pushMem(raw);
        ptrStart.patchLength(ptr);
    }

    /// @dev The same length check `PolicyEnvelope` carries, for the same reason. `InstructionArgs`
    ///   is a raw `calldataload` and 1inch documents it as performing no bounds validation, so a
    ///   truncated instruction here would read its registry address out of whatever bytes follow —
    ///   and the failure mode of a guard reading the wrong registry is a guard that passes.
    function parse(bytes calldata args)
        internal
        pure
        returns (address registry, address holder, string calldata label)
    {
        require(args.length >= HEADER, MandateNameArgsTruncated(args.length));
        registry = args.at(0).asAddress();
        holder = args.at(20).asAddress();
        uint256 len = args.at(40).asU8();
        require(args.length >= HEADER + len, MandateNameArgsTruncated(args.length));
        label = string(args[HEADER:HEADER + len]);
    }

    function exec(Context memory, bytes calldata args) internal view {
        (address registry, address holder, string calldata label) = parse(args);
        check(registry, holder, label);
    }

    /// @dev Shared with `BatasApp` so the two enforcement surfaces cannot disagree about what a
    ///   revoked name is — the same reason pricing lives in `MandateLib` rather than in each of
    ///   them.
    ///
    ///   Strictly greater than, and that is not the same rule the mandate's own deadline uses. The
    ///   two come from different systems and each matches its own counterpart: SwapVM's `Deadline`
    ///   is `block.timestamp <= deadline`, so a mandate is live through its final second, while a
    ///   name is expired at its expiry and `classifyName` off chain says so too. Making them agree
    ///   with each other would put both out of step with the thing they mirror.
    function check(address registry, address holder, string memory label) internal view {
        IMandateNameRegistry reg = IMandateNameRegistry(registry);

        // Ownership first, and the order is the whole point.
        //
        // `unregister` does not zero a name's expiry — it sets it to the moment of revocation — so
        // a name the owner pulled and one that simply ran out are indistinguishable by timestamp.
        // Checking the expiry first made every revocation report `MandateNameLapsed`, which is the
        // same wrong answer this project already fixed once off chain: the operator of a stopped
        // agent was told it had run out of time when in fact its authority had been taken away.
        //
        // Burning clears the owner and lapsing does not, so asking who holds it first separates
        // them: a revoked name fails here, a lapsed one gets past this and fails below.
        //
        // A revoked name reads as the zero address on this registry rather than reverting, so it is
        // compared as a value. A registry that does revert instead reverts the settlement, which is
        // the safe direction: no answer about the name means no trade.
        address owner = reg.ownerOf(reg.findTokenId(label));
        require(owner == holder, MandateNameNotHeld(owner, holder));

        uint64 expiry = reg.findExpiry(label);
        require(expiry > block.timestamp, MandateNameLapsed(expiry, block.timestamp));
    }
}
