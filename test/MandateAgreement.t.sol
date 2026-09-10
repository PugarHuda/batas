// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import { Test } from "forge-std/Test.sol";
import { TokenMock } from "@1inch/solidity-utils/contracts/mocks/TokenMock.sol";

import { Aqua } from "@1inch/aqua/src/Aqua.sol";
import { IAqua } from "@1inch/aqua/src/interfaces/IAqua.sol";

import { ISwapVM } from "@1inch/swap-vm/src/interfaces/ISwapVM.sol";
import { MakerTraitsLib } from "@1inch/swap-vm/src/libs/MakerTraits.sol";
import { TakerTraitsLib } from "@1inch/swap-vm/src/libs/TakerTraits.sol";

import { BatasApp } from "../src/BatasApp.sol";
import { BatasRouter } from "../src/BatasRouter.sol";
import { IBatasCallback } from "../src/IBatasCallback.sol";
import { Mandate, MandateLib } from "../src/Mandate.sol";
import { MandateName } from "../src/MandateName.sol";

/// @notice The three questions `MandateName` asks an ENSv2 registry, and nothing else.
/// @dev Modelled on the real one's behaviour rather than on a convenient one: `unregister` sets the
///   expiry to the moment of revocation instead of zeroing it, and `ownerOf` answers a burned name
///   with the zero address rather than reverting. Both of those have already misled this project
///   once — a mock that was tidier than the chain would hide the same bug twice.
contract MandateRegistryMock {
    mapping(bytes32 => uint64) private _expiry;
    mapping(bytes32 => uint256) private _id;
    mapping(uint256 => address) private _owner;

    function grant(string memory label, address owner, uint64 expiry) external {
        bytes32 k = keccak256(bytes(label));
        // Low 32 bits cleared, exactly as the real registry does, and a version counter in them
        // that re-registration bumps — which is what makes deriving the id from the label alone
        // wrong, and asking the registry right.
        _id[k] = (uint256(k) & ~uint256(0xffffffff)) | ((_id[k] & 0xffffffff) + 1);
        _expiry[k] = expiry;
        _owner[_id[k]] = owner;
    }

    /// @dev Revocation sets the expiry to the moment it happened rather than zeroing it, and burns
    ///   the owner to the zero address rather than making `ownerOf` revert. Both are what the real
    ///   registry does and both have already misled this project once. Lapsing, by contrast, leaves
    ///   the owner exactly where it was — which is the only signal that separates the two.
    function revoke(string memory label, uint64 at) external {
        bytes32 k = keccak256(bytes(label));
        _expiry[k] = at;
        _owner[_id[k]] = address(0);
    }

    function findExpiry(string calldata label) external view returns (uint64) { return _expiry[keccak256(bytes(label))]; }
    function findTokenId(string calldata label) external view returns (uint256) { return _id[keccak256(bytes(label))]; }
    function ownerOf(uint256 tokenId) external view returns (address) { return _owner[tokenId]; }
}

/// @notice Proves the two enforcement surfaces are one system.
/// @dev Batas checks a mandate in two places: inside `BatasApp`, which is an Aqua application, and
///   inside the VM through `PolicyEnvelope`, which the router runs. Two implementations of the
///   same rule would be a liability — the interesting failure is not one of them being wrong, it
///   is the two of them disagreeing, because then the mandate means something different depending
///   on which door a trade came through.
///
///   So both derive from a single `Mandate`: the app reads its fields directly, and
///   `MandateLib.toProgram` compiles the same fields into bytecode for the router. These tests ship
///   identical reserves to both and check trade by trade that they price the same and refuse the
///   same.
contract MandateAgreementTest is Test, IBatasCallback {
    using MandateLib for Mandate;

    Aqua internal aqua;
    BatasApp internal app;
    BatasRouter internal router;
    TokenMock internal tokenA;
    TokenMock internal tokenB;

    address internal maker = makeAddr("maker");
    address internal agent = makeAddr("agent");

    uint256 internal constant RESERVE_IN = 1_000e18;
    uint256 internal constant RESERVE_OUT = 2_000e18;

    function setUp() public {
        aqua = new Aqua();
        app = new BatasApp(IAqua(address(aqua)));
        router = new BatasRouter(address(aqua), address(0), address(this), "Batas", "1.0.0");

        tokenA = new TokenMock("A", "A");
        tokenB = new TokenMock("B", "B");
        if (tokenA > tokenB) (tokenA, tokenB) = (tokenB, tokenA);

        // Enough for two independent positions holding the same reserves.
        tokenA.mint(maker, RESERVE_IN * 2);
        tokenB.mint(maker, RESERVE_OUT * 2);
        vm.startPrank(maker);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenB.approve(address(aqua), type(uint256).max);
        vm.stopPrank();

        tokenA.mint(address(this), 10_000e18);
        tokenA.approve(address(aqua), type(uint256).max);
        tokenA.approve(address(router), type(uint256).max);
        tokenB.approve(address(router), type(uint256).max);
    }

    function _mandate(uint128 maxAmountIn, uint128 minRateE18) internal view returns (Mandate memory m) {
        return _mandate(maxAmountIn, minRateE18, uint64(block.timestamp + 2 hours), 0.003e7);
    }

    function _mandate(uint128 maxAmountIn, uint128 minRateE18, uint64 expiry, uint24 feeBps)
        internal
        view
        returns (Mandate memory m)
    {
        m = Mandate({
            maker: maker,
            agent: agent,
            tokenIn: address(tokenA),
            tokenOut: address(tokenB),
            maxAmountIn: maxAmountIn,
            minRateE18: minRateE18,
            expiry: expiry,
            feeBps: feeBps,
            salt: 1,
            nameRegistry: address(0),
            nameHolder: address(0),
            nameLabel: ""
        });
    }

    /// @dev Ships the same reserves twice: once to the app under the encoded mandate, once to the
    ///   router under the encoded order whose program was compiled from that mandate.
    function _shipBoth(Mandate memory m) internal returns (ISwapVM.Order memory order) {
        address[] memory tokens = new address[](2);
        tokens[0] = address(tokenA);
        tokens[1] = address(tokenB);
        uint256[] memory amounts = new uint256[](2);
        amounts[0] = RESERVE_IN;
        amounts[1] = RESERVE_OUT;

        vm.prank(maker);
        aqua.ship(address(app), m.encode(), tokens, amounts);

        order = _order(m.toProgram());
        vm.prank(maker);
        aqua.ship(address(router), abi.encode(order), tokens, amounts);
    }

    function batasSwapCallback(address tokenIn_, address, uint256 amountIn, uint256, address maker_, bytes32 h, bytes calldata)
        external
    {
        TokenMock(tokenIn_).mint(address(this), amountIn);
        aqua.push(maker_, address(app), h, tokenIn_, amountIn);
    }

    /// @notice Same mandate, same reserves, same trade: both surfaces must return the same output.
    function test_BothSurfacesPriceIdentically() public {
        Mandate memory m = _mandate(500e18, 1e18);
        ISwapVM.Order memory order = _shipBoth(m);

        uint256[3] memory sizes = [uint256(1e18), 25e18, 200e18];
        for (uint256 i = 0; i < sizes.length; i++) {
            uint256 fromApp = app.quote(m, sizes[i]);
            (, uint256 fromVm,) = router.quote(order, sizes[i], _takerData());
            assertEq(fromApp, fromVm, "app and VM must price a mandate identically");
            assertGt(fromApp, 0, "and actually price it");
        }
    }

    /// @notice A trade over the cap must be refused by both, not just whichever one it reached.
    function test_BothSurfacesRefuseOverCap() public {
        Mandate memory m = _mandate(100e18, 1e18);
        ISwapVM.Order memory order = _shipBoth(m);
        uint256 tooBig = 150e18;

        vm.expectRevert();
        app.quote(m, tooBig);

        bytes memory takerData = _takerData();
        vm.expectRevert();
        router.swap(order, tooBig, takerData);
    }

    /// @notice And a price under the floor is refused by both.
    function test_BothSurfacesRefuseBelowFloor() public {
        // The pool opens at 2.0; a 1.99 floor is broken by any size worth trading.
        Mandate memory m = _mandate(500e18, 1.99e18);
        ISwapVM.Order memory order = _shipBoth(m);

        vm.expectRevert();
        app.quote(m, 50e18);

        bytes memory takerData = _takerData();
        vm.expectRevert();
        router.swap(order, 50e18, takerData);
    }

    /// @notice Expiry too, though each expresses it in its own vocabulary: the app raises
    ///   MandateExpired, the compiled program reaches SwapVM's Deadline instruction. Different
    ///   error, same refusal.
    function test_BothSurfacesRefuseAfterExpiry() public {
        Mandate memory m = _mandate(500e18, 1e18);
        ISwapVM.Order memory order = _shipBoth(m);

        vm.warp(uint256(m.expiry) + 1);

        vm.expectRevert();
        app.quote(m, 10e18);

        bytes memory takerData = _takerData();
        vm.expectRevert();
        router.swap(order, 10e18, takerData);
    }

    function _order(bytes memory program) internal view returns (ISwapVM.Order memory) {
        return MakerTraitsLib.build(
            MakerTraitsLib.Args({
                maker: maker,
                receiver: address(0),
                tokenA: address(tokenA),
                tokenB: address(tokenB),
                shouldUnwrapWeth: false,
                useAquaInsteadOfSignature: true,
                allowZeroAmountIn: false,
                hasPreTransferInHook: false,
                hasPostTransferInHook: false,
                hasPreTransferOutHook: false,
                hasPostTransferOutHook: false,
                preTransferInTarget: address(0),
                preTransferInData: "",
                postTransferInTarget: address(0),
                postTransferInData: "",
                preTransferOutTarget: address(0),
                preTransferOutData: "",
                postTransferOutTarget: address(0),
                postTransferOutData: "",
                program: program
            })
        );
    }

    function _takerData() internal view returns (bytes memory) {
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: address(this),
                isExactIn: true,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: true,
                useTransferFromAndAquaPush: true,
                isAToB: true,
                allowPartialFill: false,
                threshold: "",
                to: address(this),
                deadline: 0,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
    }

    /// @notice The agreement has to hold for arbitrary terms, not three sizes someone chose.
    /// @dev Foundry reverts state between fuzz runs, so each case ships a fresh position. The
    ///   assertion is deliberately about *outcomes* rather than amounts: either both surfaces
    ///   settle and agree to the wei, or both refuse. A case where one accepts and the other
    ///   rejects is the failure that matters, because then the mandate would mean different
    ///   things depending on which door a trade arrived through.
    ///
    ///   All five terms vary, and the last two are why this signature grew. `expiry` and `feeBps`
    ///   were held fixed here, which left the agreement unchecked in exactly the place the two
    ///   surfaces encode a term differently: the app reads a `uint64` timestamp and the program
    ///   carries a five-byte one, and the fee is a `uint24` fed into a basis of 1e7. Holding a
    ///   term constant in a test about disagreement excuses the term most able to disagree.
    function testFuzz_SurfacesAgreeOnArbitraryTerms(
        uint128 rawCap,
        uint128 rawFloor,
        uint96 rawAmount,
        uint64 rawExpiry,
        uint24 rawFee
    ) public {
        // Somewhere with room on both sides, so "already expired" is as reachable as "still live".
        vm.warp(1_800_000_000);

        uint128 cap = uint128(bound(rawCap, 0, 800e18));
        uint128 floorRate = uint128(bound(rawFloor, 0, 3e18));
        uint256 amountIn = bound(rawAmount, 1, 800e18);
        uint64 expiry = uint64(bound(rawExpiry, block.timestamp - 1 days, block.timestamp + 90 days));
        uint24 feeBps = uint24(bound(rawFee, 0, MandateLib.BPS - 1));

        Mandate memory m = _mandate(cap, floorRate, expiry, feeBps);
        ISwapVM.Order memory order = _shipBoth(m);

        bool appOk;
        uint256 appOut;
        try app.quote(m, amountIn) returns (uint256 out) {
            appOk = true;
            appOut = out;
        } catch { }

        bool vmOk;
        uint256 vmOut;
        try router.quote(order, amountIn, _takerData()) returns (uint256, uint256 out, bytes32) {
            vmOk = true;
            vmOut = out;
        } catch { }

        assertEq(appOk, vmOk, "one surface accepted a trade the other refused");
        if (appOk) assertEq(appOut, vmOut, "both accepted but priced it differently");
    }

    /// @dev `toProgram` is an internal library call, so a revert from it happens at the same call
    ///   depth as the cheatcode and `expectRevert` cannot see it. This is the external door.
    function compile(Mandate memory m) external pure returns (bytes memory) {
        return m.toProgram();
    }

    /// @notice The expiry second itself belongs to whoever holds the mandate, on both surfaces.
    /// @dev Found by the fuzz above the moment `expiry` stopped being held fixed. SwapVM's
    ///   `Deadline` is `block.timestamp <= deadline`; `BatasApp` was `<`. For exactly one second
    ///   the same mandate authorised a trade through the VM and refused it through the app, which
    ///   is the disagreement this whole file exists to prevent, sitting in the term the file never
    ///   varied. Pinned by name as well as by fuzz, because a boundary a fuzzer reaches by luck is
    ///   one a later change can quietly move back.
    function test_TheExpirySecondIsHonouredByBothSurfaces() public {
        uint64 expiry = uint64(block.timestamp + 1 hours);
        Mandate memory m = _mandate(500e18, 1e18, expiry, 0.003e7);
        ISwapVM.Order memory order = _shipBoth(m);

        vm.warp(expiry);
        uint256 fromApp = app.quote(m, 10e18);
        (, uint256 fromVm,) = router.quote(order, 10e18, _takerData());
        assertEq(fromApp, fromVm, "the expiry second must price identically on both surfaces");
        assertGt(fromApp, 0, "and must still be a live mandate");

        vm.warp(expiry + 1);
        vm.expectRevert();
        app.quote(m, 10e18);
        vm.expectRevert();
        router.quote(order, 10e18, _takerData());
    }

    /// @notice The compiler declines terms the program cannot carry, rather than carrying others.
    /// @dev `Deadline` holds five bytes. A `uint64` expiry past `uint40` would have been truncated
    ///   silently, leaving the app checking one timestamp and the program another — the same
    ///   disagreement as above, reached by a different road.
    function test_AnExpiryTooLargeToEncodeIsRefused() public {
        Mandate memory m = _mandate(500e18, 1e18, uint64(type(uint40).max) + 1, 0.003e7);
        vm.expectRevert(
            abi.encodeWithSelector(MandateLib.MandateExpiryUnencodable.selector, uint64(type(uint40).max) + 1)
        );
        this.compile(m);

        // And the largest one it can carry still compiles.
        m.expiry = uint64(type(uint40).max);
        assertGt(this.compile(m).length, 0);
    }

    /// @notice A fee that consumes the whole input is not a fee, and is refused at compile time.
    function test_AFeeAtOrPastTheBasisIsRefused() public {
        Mandate memory m = _mandate(500e18, 1e18, uint64(block.timestamp + 1 hours), uint24(MandateLib.BPS));
        vm.expectRevert(abi.encodeWithSelector(MandateLib.MandateFeeExceedsBasis.selector, uint24(MandateLib.BPS)));
        this.compile(m);

        m.feeBps = uint24(MandateLib.BPS - 1);
        assertGt(this.compile(m).length, 0);
    }

    // --- the kill switch, made binding -------------------------------------------------------
    //
    // The ENSv2 subname expressed the agent's authority from the start, and the agent consulted it
    // before acting. Nothing on chain did, so revoking the name stopped the agent that asks and
    // nobody else: a second copy of it, or an ordinary taker arriving at a position still shipped,
    // was never stopped by the name at all. `MandateName` puts the question into the settlement,
    // and these tests hold both surfaces to the same answer.

    MandateRegistryMock internal names;

    function _named(string memory label, address holder) internal returns (Mandate memory m) {
        if (address(names) == address(0)) names = new MandateRegistryMock();
        m = _mandate(500e18, 1e18);
        m.nameRegistry = address(names);
        m.nameHolder = holder;
        m.nameLabel = label;
    }

    /// @notice A name that is held and unexpired settles, on both surfaces.
    function test_BothSurfacesSettleWhileTheNameHolds() public {
        Mandate memory m = _named("agent", agent);
        names.grant("agent", agent, uint64(block.timestamp + 1 days));
        ISwapVM.Order memory order = _shipBoth(m);

        uint256 fromApp = app.quote(m, 10e18);
        (, uint256 fromVm,) = router.quote(order, 10e18, _takerData());
        assertEq(fromApp, fromVm, "a live name must not change what a trade is worth");
        assertGt(fromApp, 0);
    }

    /// @notice Revoke the name and every caller is stopped, not merely the agent that asks.
    /// @dev This is the whole point of the instruction. The taker here is this contract, which has
    ///   never heard of the name and would happily trade; the registry says the grant is gone and
    ///   the settlement refuses anyway.
    function test_RevokingTheNameStopsBothSurfaces() public {
        Mandate memory m = _named("agent", agent);
        names.grant("agent", agent, uint64(block.timestamp + 1 days));
        ISwapVM.Order memory order = _shipBoth(m);

        assertGt(app.quote(m, 10e18), 0, "the position must work before it is stopped");

        names.revoke("agent", uint64(block.timestamp));

        // Reported as a withdrawal, not as a lapse. `unregister` sets the expiry to the moment of
        // revocation rather than zeroing it, so checking the expiry first would call every
        // revocation a name that ran out — the same wrong answer this project fixed off chain, and
        // the reason `check` asks who holds it before it asks until when.
        vm.expectPartialRevert(MandateName.MandateNameNotHeld.selector);
        app.quote(m, 10e18);
        bytes memory takerData = _takerData();
        vm.expectPartialRevert(MandateName.MandateNameNotHeld.selector);
        router.quote(order, 10e18, takerData);
    }

    /// @notice A name that simply ran out stops it too, and by the registry's own rule.
    /// @dev Strictly greater than, which is deliberately *not* the rule the mandate's own deadline
    ///   uses. SwapVM's `Deadline` is `<=`, so a mandate is live through its final second; a name
    ///   is expired at its expiry, and `classifyName` off chain agrees. Each surface matches the
    ///   system it mirrors rather than matching the other one.
    function test_ALapsedNameStopsBothSurfaces() public {
        Mandate memory m = _named("agent", agent);
        names.grant("agent", agent, uint64(block.timestamp + 1 hours));
        ISwapVM.Order memory order = _shipBoth(m);

        vm.warp(block.timestamp + 1 hours);
        // And a name that simply ran out says so, rather than borrowing the other one's word.
        vm.expectPartialRevert(MandateName.MandateNameLapsed.selector);
        app.quote(m, 10e18);
        bytes memory takerData = _takerData();
        vm.expectPartialRevert(MandateName.MandateNameLapsed.selector);
        router.quote(order, 10e18, takerData);
    }

    /// @notice And a name held by somebody else is not this agent's authority.
    function test_ANameHeldByAnotherAddressStopsBothSurfaces() public {
        Mandate memory m = _named("agent", agent);
        names.grant("agent", makeAddr("someone else"), uint64(block.timestamp + 1 days));
        ISwapVM.Order memory order = _shipBoth(m);

        vm.expectRevert();
        app.quote(m, 10e18);
        bytes memory takerData = _takerData();
        vm.expectRevert();
        router.quote(order, 10e18, takerData);
    }

    /// @notice A mandate that names no registry is unchanged, and that is a choice, not a default.
    function test_WithoutARegistryNothingIsAsked() public {
        Mandate memory m = _mandate(500e18, 1e18);
        assertEq(m.nameRegistry, address(0));
        ISwapVM.Order memory order = _shipBoth(m);
        assertGt(app.quote(m, 10e18), 0);
        (, uint256 fromVm,) = router.quote(order, 10e18, _takerData());
        assertGt(fromVm, 0);
    }

    /// @notice A mandate whose floor is unreachable must be refused by both, never by one.
    function testFuzz_ImpossibleFloorRefusedByBoth(uint128 rawFloor, uint96 rawAmount) public {
        // The pool opens at 2.0 and only moves down as it is bought, so anything above 2.0 is
        // unreachable for a non-zero trade.
        uint128 floorRate = uint128(bound(rawFloor, 2.01e18, 100e18));
        uint256 amountIn = bound(rawAmount, 1e15, 500e18);

        Mandate memory m = _mandate(type(uint128).max, floorRate);
        ISwapVM.Order memory order = _shipBoth(m);

        vm.expectRevert();
        app.quote(m, amountIn);

        bytes memory takerData = _takerData();
        vm.expectRevert();
        router.swap(order, amountIn, takerData);
    }
}
