// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Chronos} from "../Chronos.sol";
import {MockERC20} from "../test-helpers/MockERC20.sol";

contract ChronosTest is Test {
    // ─── actors ───────────────────────────────────────────────────────────────
    address internal owner   = makeAddr("owner");
    address internal oracle  = makeAddr("oracle");
    address internal treasury = makeAddr("treasury");
    address internal alice   = makeAddr("alice");
    address internal bob     = makeAddr("bob");
    address internal carol   = makeAddr("carol");

    // ─── deployment params ────────────────────────────────────────────────────
    uint256 internal constant FEE_BPS     = 500;  // 5 %
    uint256 internal constant GRACE       = 180 days;

    // ─── time helpers ─────────────────────────────────────────────────────────
    uint256 internal constant T0          = 1_700_000_000; // deterministic start
    uint64  internal constant T_TRADE     = uint64(T0 + 2 days);
    uint64  internal constant T_RESOLVE   = uint64(T0 + 7 days);

    // ─── contracts ────────────────────────────────────────────────────────────
    MockERC20 internal usdc;
    Chronos   internal chronos;

    // ─── question strings ─────────────────────────────────────────────────────
    string internal constant Q   = "Will ETH hit 10k?";
    string internal constant C   = "Based on CoinGecko closing price.";

    // ─── helper: create a standard market from address `who` ─────────────────
    function _createMarket(address who) internal returns (uint256 id) {
        vm.prank(who);
        id = chronos.createMarket(Q, C, T_TRADE, T_RESOLVE);
    }

    // ─── setUp ────────────────────────────────────────────────────────────────
    function setUp() public {
        vm.warp(T0);

        usdc = new MockERC20("Mock USDC", "mUSDC", 6);

        vm.prank(owner);
        chronos = new Chronos(
            address(usdc),
            oracle,
            treasury,
            FEE_BPS,
            GRACE,
            owner
        );

        // Seed balances and approvals
        usdc.mint(alice, 10_000e6);
        usdc.mint(bob,   10_000e6);
        usdc.mint(carol, 10_000e6);

        vm.prank(alice); usdc.approve(address(chronos), type(uint256).max);
        vm.prank(bob);   usdc.approve(address(chronos), type(uint256).max);
        vm.prank(carol); usdc.approve(address(chronos), type(uint256).max);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  DEPLOYMENT / INITIALIZATION
    // ═══════════════════════════════════════════════════════════════════════════

    function test_DeploymentSetsState() public view {
        assertEq(address(chronos.usdc()),    address(usdc));
        assertEq(chronos.oracle(),           oracle);
        assertEq(chronos.treasury(),         treasury);
        assertEq(chronos.feeBps(),           FEE_BPS);
        assertEq(chronos.gracePeriod(),      GRACE);
        assertEq(chronos.owner(),            owner);
        assertEq(chronos.marketCount(),      0);
        assertEq(chronos.pendingFees(),      0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  createMarket
    // ═══════════════════════════════════════════════════════════════════════════

    function test_CreateMarket_Valid() public {
        vm.expectEmit(true, true, false, true, address(chronos));
        emit Chronos.MarketCreated(0, alice, Q, T_TRADE, T_RESOLVE);
        uint256 id = _createMarket(alice);

        assertEq(id, 0);
        assertEq(chronos.marketCount(), 1);

        Chronos.Market memory m = chronos.getMarket(0);
        assertEq(m.question,          Q);
        assertEq(m.resolutionCriteria, C);
        assertEq(m.tradingDeadline,   T_TRADE);
        assertEq(m.resolutionDeadline, T_RESOLVE);
        assertEq(uint8(m.outcome),    uint8(Chronos.Outcome.UNRESOLVED));
        assertEq(uint8(m.state),      uint8(Chronos.MarketState.Open));
        assertEq(m.creator,           alice);
        assertEq(m.feeBps,            FEE_BPS);
    }

    function test_CreateMarket_EmptyQuestion_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(Chronos.InvalidQuestion.selector);
        chronos.createMarket("", C, T_TRADE, T_RESOLVE);
    }

    function test_CreateMarket_QuestionOver1024_Reverts() public {
        // build a 1025-byte string
        bytes memory big = new bytes(1025);
        for (uint256 i; i < 1025; ++i) big[i] = "x";
        string memory bigQ = string(big);

        vm.prank(alice);
        vm.expectRevert(Chronos.InvalidQuestion.selector);
        chronos.createMarket(bigQ, C, T_TRADE, T_RESOLVE);
    }

    function test_CreateMarket_InvertedDeadlines_Reverts() public {
        // tradingDeadline == resolutionDeadline  →  not strictly less than
        vm.prank(alice);
        vm.expectRevert(Chronos.InvalidDeadline.selector);
        chronos.createMarket(Q, C, T_RESOLVE, T_TRADE); // swapped
    }

    function test_CreateMarket_TradingEqResolution_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(Chronos.InvalidDeadline.selector);
        chronos.createMarket(Q, C, T_TRADE, T_TRADE); // equal
    }

    function test_CreateMarket_PastResolutionDeadline_Reverts() public {
        // both deadlines in the past
        vm.warp(T0 + 10 days);
        vm.prank(alice);
        vm.expectRevert(Chronos.InvalidDeadline.selector);
        chronos.createMarket(Q, C, T_TRADE, T_RESOLVE);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  buyShares
    // ═══════════════════════════════════════════════════════════════════════════

    function test_BuyShares_ValidYES() public {
        _createMarket(alice);
        uint256 beforeBal = usdc.balanceOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(chronos));
        emit Chronos.SharesPurchased(0, alice, uint8(Chronos.Outcome.YES), 100e6);
        chronos.buyShares(0, Chronos.Outcome.YES, 100e6);

        assertEq(usdc.balanceOf(alice),           beforeBal - 100e6);
        assertEq(usdc.balanceOf(address(chronos)), 100e6);
        assertEq(chronos.yesShares(0, alice),      100e6);

        Chronos.Market memory m = chronos.getMarket(0);
        assertEq(m.yesPool, 100e6);
        assertEq(m.noPool,  0);
    }

    function test_BuyShares_ValidNO() public {
        _createMarket(alice);

        vm.prank(bob);
        vm.expectEmit(true, true, false, true, address(chronos));
        emit Chronos.SharesPurchased(0, bob, uint8(Chronos.Outcome.NO), 200e6);
        chronos.buyShares(0, Chronos.Outcome.NO, 200e6);

        assertEq(chronos.noShares(0, bob), 200e6);
        Chronos.Market memory m = chronos.getMarket(0);
        assertEq(m.noPool, 200e6);
    }

    function test_BuyShares_ZeroAmount_Reverts() public {
        _createMarket(alice);
        vm.prank(alice);
        vm.expectRevert(Chronos.NoShares.selector);
        chronos.buyShares(0, Chronos.Outcome.YES, 0);
    }

    function test_BuyShares_StateNotOpen_Reverts() public {
        _createMarket(alice);
        // Advance past tradingDeadline and close trading
        vm.warp(T_TRADE + 1);
        chronos.closeTrading(0);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                Chronos.InvalidMarketState.selector,
                uint8(Chronos.MarketState.TradingClosed),
                uint8(Chronos.MarketState.Open)
            )
        );
        chronos.buyShares(0, Chronos.Outcome.YES, 100e6);
    }

    function test_BuyShares_AfterTradingDeadline_Reverts() public {
        _createMarket(alice);
        vm.warp(T_TRADE); // exactly at deadline (>= triggers revert)

        vm.prank(alice);
        vm.expectRevert(Chronos.TradingClosed_.selector);
        chronos.buyShares(0, Chronos.Outcome.YES, 100e6);
    }

    function test_BuyShares_OutcomeUnresolved_Reverts() public {
        _createMarket(alice);
        vm.prank(alice);
        vm.expectRevert(Chronos.InvalidOutcome.selector);
        chronos.buyShares(0, Chronos.Outcome.UNRESOLVED, 100e6);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  closeTrading
    // ═══════════════════════════════════════════════════════════════════════════

    function test_CloseTrading_BeforeDeadline_Reverts() public {
        _createMarket(alice);
        vm.expectRevert(Chronos.TradingOpen.selector);
        chronos.closeTrading(0);
    }

    function test_CloseTrading_AfterDeadline_Success() public {
        _createMarket(alice);

        vm.prank(alice);
        chronos.buyShares(0, Chronos.Outcome.YES, 300e6);
        vm.prank(bob);
        chronos.buyShares(0, Chronos.Outcome.NO,  700e6);

        vm.warp(T_TRADE + 1);

        vm.expectEmit(true, false, false, true, address(chronos));
        emit Chronos.TradingClosed(0, 1000e6);
        chronos.closeTrading(0);

        Chronos.Market memory m = chronos.getMarket(0);
        assertEq(uint8(m.state),    uint8(Chronos.MarketState.TradingClosed));
        assertEq(m.totalPool,       1000e6);
    }

    function test_CloseTrading_AlreadyClosed_Reverts() public {
        _createMarket(alice);
        vm.warp(T_TRADE + 1);
        chronos.closeTrading(0);

        vm.expectRevert(
            abi.encodeWithSelector(
                Chronos.InvalidMarketState.selector,
                uint8(Chronos.MarketState.TradingClosed),
                uint8(Chronos.MarketState.Open)
            )
        );
        chronos.closeTrading(0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  resolveMarket
    // ═══════════════════════════════════════════════════════════════════════════

    function _setupTradingClosed() internal returns (uint256 id) {
        id = _createMarket(alice);
        vm.prank(alice);
        chronos.buyShares(id, Chronos.Outcome.YES, 200e6);
        vm.prank(bob);
        chronos.buyShares(id, Chronos.Outcome.NO, 800e6);
        vm.warp(T_TRADE + 1);
        chronos.closeTrading(id);
    }

    function test_ResolveMarket_ValidYES() public {
        uint256 id = _setupTradingClosed();
        vm.warp(T_TRADE + 2);

        vm.prank(oracle);
        vm.expectEmit(true, false, false, true, address(chronos));
        emit Chronos.MarketResolved(id, uint8(Chronos.Outcome.YES), "ipfs://abc", uint64(block.timestamp));
        chronos.resolveMarket(id, Chronos.Outcome.YES, "ipfs://abc");

        Chronos.Market memory m = chronos.getMarket(id);
        assertEq(uint8(m.state),   uint8(Chronos.MarketState.Resolved));
        assertEq(uint8(m.outcome), uint8(Chronos.Outcome.YES));
        assertEq(m.resolvedAt,     uint64(block.timestamp));
        assertEq(m.evidenceURI,    "ipfs://abc");
    }

    function test_ResolveMarket_ValidNO() public {
        uint256 id = _setupTradingClosed();
        vm.prank(oracle);
        chronos.resolveMarket(id, Chronos.Outcome.NO, "ipfs://xyz");

        Chronos.Market memory m = chronos.getMarket(id);
        assertEq(uint8(m.outcome), uint8(Chronos.Outcome.NO));
    }

    function test_ResolveMarket_NonOracle_Reverts() public {
        uint256 id = _setupTradingClosed();
        vm.prank(alice);
        vm.expectRevert(Chronos.InvalidAddress.selector);
        chronos.resolveMarket(id, Chronos.Outcome.YES, "");
    }

    function test_ResolveMarket_StateNotTradingClosed_Reverts() public {
        // Market still Open (trading deadline not yet reached)
        uint256 id = _createMarket(alice);
        vm.prank(oracle);
        vm.expectRevert(
            abi.encodeWithSelector(
                Chronos.InvalidMarketState.selector,
                uint8(Chronos.MarketState.Open),
                uint8(Chronos.MarketState.TradingClosed)
            )
        );
        chronos.resolveMarket(id, Chronos.Outcome.YES, "");
    }

    function test_ResolveMarket_AfterResolutionDeadline_Reverts() public {
        uint256 id = _setupTradingClosed();
        vm.warp(T_RESOLVE + 1);

        vm.prank(oracle);
        vm.expectRevert(Chronos.InvalidDeadline.selector);
        chronos.resolveMarket(id, Chronos.Outcome.YES, "");
    }

    function test_ResolveMarket_OutcomeUnresolved_Reverts() public {
        uint256 id = _setupTradingClosed();
        vm.prank(oracle);
        vm.expectRevert(Chronos.InvalidOutcome.selector);
        chronos.resolveMarket(id, Chronos.Outcome.UNRESOLVED, "");
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  markRefundable
    // ═══════════════════════════════════════════════════════════════════════════

    function test_MarkRefundable_BeforeDeadline_Reverts() public {
        _createMarket(alice);
        // still before resolutionDeadline
        vm.expectRevert(Chronos.InvalidDeadline.selector);
        chronos.markRefundable(0);
    }

    function test_MarkRefundable_Valid() public {
        _createMarket(alice);
        vm.warp(T_RESOLVE + 1);

        vm.expectEmit(true, false, false, false, address(chronos));
        emit Chronos.MarketRefundable(0);
        chronos.markRefundable(0);

        Chronos.Market memory m = chronos.getMarket(0);
        assertEq(uint8(m.state), uint8(Chronos.MarketState.Refundable));
    }

    function test_MarkRefundable_AlreadyResolved_Reverts() public {
        uint256 id = _setupTradingClosed();
        vm.prank(oracle);
        chronos.resolveMarket(id, Chronos.Outcome.YES, "");

        vm.warp(T_RESOLVE + 1);
        vm.expectRevert(
            abi.encodeWithSelector(
                Chronos.InvalidMarketState.selector,
                uint8(Chronos.MarketState.Resolved),
                uint8(Chronos.MarketState.TradingClosed)
            )
        );
        chronos.markRefundable(id);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  claimWinnings  +  pendingFees  +  fee math
    // ═══════════════════════════════════════════════════════════════════════════

    // Helper: resolve market YES with alice=200e6 YES, bob=800e6 NO
    function _setupResolved() internal returns (uint256 id) {
        id = _setupTradingClosed();
        vm.prank(oracle);
        chronos.resolveMarket(id, Chronos.Outcome.YES, "evidence");
    }

    function test_ClaimWinnings_WinningSide_CorrectFeeMath() public {
        uint256 id = _setupResolved();

        // Alice: yesShares=200e6, totalPool=1000e6, yesPool=200e6
        // grossPayout  = 200 * 1000 / 200 = 1000e6
        // profit       = 1000 - 200         = 800e6
        // fee          = 800 * 500 / 10000  = 40e6
        // netPayout    = 1000 - 40           = 960e6
        uint256 expectedGross   = 1000e6;
        uint256 expectedProfit  = 800e6;
        uint256 expectedFee     = 40e6;
        uint256 expectedNet     = 960e6;

        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(chronos));
        emit Chronos.WinningsClaimed(id, alice, expectedNet, 200e6, expectedProfit, expectedFee);
        chronos.claimWinnings(id);

        // Alice received exactly netPayout (NOT grossPayout)
        assertEq(usdc.balanceOf(alice) - aliceBefore, expectedNet);

        // fee is pending, NOT yet in treasury
        assertEq(chronos.pendingFees(), expectedFee);
        assertEq(usdc.balanceOf(treasury), 0, "treasury must not receive directly");

        // claimed flag set
        assertTrue(chronos.claimed(id, alice));
    }

    function test_ClaimWinnings_LosingSide_Reverts() public {
        uint256 id = _setupResolved(); // YES wins

        vm.prank(bob); // bob holds only NO shares
        vm.expectRevert(Chronos.NoShares.selector);
        chronos.claimWinnings(id);
    }

    function test_ClaimWinnings_DoubleClaim_Reverts() public {
        uint256 id = _setupResolved();

        vm.prank(alice);
        chronos.claimWinnings(id);

        vm.prank(alice);
        vm.expectRevert(Chronos.AlreadyClaimed.selector);
        chronos.claimWinnings(id);
    }

    function test_ClaimWinnings_NotResolved_Reverts() public {
        _createMarket(alice);

        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                Chronos.InvalidMarketState.selector,
                uint8(Chronos.MarketState.Open),
                uint8(Chronos.MarketState.Resolved)
            )
        );
        chronos.claimWinnings(0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  withdrawFees
    // ═══════════════════════════════════════════════════════════════════════════

    function test_WithdrawFees_SendsPendingToTreasury() public {
        uint256 id = _setupResolved();
        vm.prank(alice);
        chronos.claimWinnings(id);

        uint256 pending = chronos.pendingFees();
        assertGt(pending, 0);

        vm.expectEmit(false, false, false, true, address(chronos));
        emit Chronos.FeesWithdrawn(treasury, pending);
        chronos.withdrawFees();

        assertEq(usdc.balanceOf(treasury), pending);
        assertEq(chronos.pendingFees(),    0);
    }

    function test_WithdrawFees_ZeroPending_Reverts() public {
        vm.expectRevert(Chronos.NoUnclaimed.selector);
        chronos.withdrawFees();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  claimRefund
    // ═══════════════════════════════════════════════════════════════════════════

    function _setupRefundable() internal returns (uint256 id) {
        id = _createMarket(alice);
        vm.prank(alice);
        chronos.buyShares(id, Chronos.Outcome.YES, 300e6);
        vm.prank(bob);
        chronos.buyShares(id, Chronos.Outcome.NO,  700e6);
        vm.warp(T_RESOLVE + 1);
        chronos.markRefundable(id);
    }

    function test_ClaimRefund_Valid_ReturnsExactStake() public {
        uint256 id = _setupRefundable();
        uint256 aliceBefore = usdc.balanceOf(alice);

        vm.prank(alice);
        vm.expectEmit(true, true, false, true, address(chronos));
        emit Chronos.RefundClaimed(id, alice, 300e6);
        chronos.claimRefund(id);

        assertEq(usdc.balanceOf(alice) - aliceBefore, 300e6);
        assertTrue(chronos.claimed(id, alice));
    }

    function test_ClaimRefund_DoubleRefund_Reverts() public {
        uint256 id = _setupRefundable();

        vm.prank(alice);
        chronos.claimRefund(id);

        vm.prank(alice);
        vm.expectRevert(Chronos.AlreadyClaimed.selector);
        chronos.claimRefund(id);
    }

    function test_ClaimRefund_WrongState_Reverts() public {
        _createMarket(alice);
        // Market is Open, not Refundable
        vm.prank(alice);
        vm.expectRevert(
            abi.encodeWithSelector(
                Chronos.InvalidMarketState.selector,
                uint8(Chronos.MarketState.Open),
                uint8(Chronos.MarketState.Refundable)
            )
        );
        chronos.claimRefund(0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  sweepUnclaimed
    // ═══════════════════════════════════════════════════════════════════════════

    function _setupResolvedForSweep() internal returns (uint256 id) {
        id = _setupTradingClosed();
        vm.prank(oracle);
        chronos.resolveMarket(id, Chronos.Outcome.YES, "ev");
        // alice wins 200e6→1000e6 gross; bob has 800e6 NO (loses) — neither claims
    }

    function test_SweepUnclaimed_BeforeGracePeriod_Reverts() public {
        uint256 id = _setupResolvedForSweep();

        // Just past resolvedAt but grace period (180 days) not elapsed
        vm.warp(block.timestamp + 1 days);

        vm.prank(owner);
        vm.expectRevert(Chronos.GracePeriodNotElapsed.selector);
        chronos.sweepUnclaimed(id);
    }

    function test_SweepUnclaimed_Valid() public {
        uint256 id = _setupResolvedForSweep();
        Chronos.Market memory m = chronos.getMarket(id);

        // Advance past grace period
        vm.warp(uint256(m.resolvedAt) + GRACE + 1);

        uint256 remaining = m.totalPool; // nobody claimed, settledAmount == 0
        uint256 treasuryBefore = usdc.balanceOf(treasury);

        vm.prank(owner);
        vm.expectEmit(true, false, false, true, address(chronos));
        emit Chronos.UnclaimedSwept(id, treasury, remaining);
        chronos.sweepUnclaimed(id);

        assertEq(usdc.balanceOf(treasury) - treasuryBefore, remaining);

        Chronos.Market memory m2 = chronos.getMarket(id);
        assertTrue(m2.swept);
        assertEq(uint8(m2.state), uint8(Chronos.MarketState.Settled));
    }

    function test_SweepUnclaimed_AlreadySwept_Reverts() public {
        uint256 id = _setupResolvedForSweep();
        Chronos.Market memory m = chronos.getMarket(id);
        vm.warp(uint256(m.resolvedAt) + GRACE + 1);

        vm.prank(owner);
        chronos.sweepUnclaimed(id);

        // After sweep, state = Settled (4).  The state-check fires before the
        // swept-flag check, so the revert is InvalidMarketState(4 /*Settled*/, 2 /*Resolved*/).
        vm.prank(owner);
        vm.expectRevert(
            abi.encodeWithSelector(
                Chronos.InvalidMarketState.selector,
                uint8(Chronos.MarketState.Settled),
                uint8(Chronos.MarketState.Resolved)
            )
        );
        chronos.sweepUnclaimed(id);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  PAUSE behaviour
    // ═══════════════════════════════════════════════════════════════════════════

    modifier paused() {
        vm.prank(owner);
        chronos.pause();
        _;
    }

    function test_Pause_CreateMarket_Reverts() public paused {
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        chronos.createMarket(Q, C, T_TRADE, T_RESOLVE);
    }

    function test_Pause_BuyShares_Reverts() public paused {
        // create market before pausing (need non-paused createMarket)
        vm.prank(owner); chronos.unpause();
        _createMarket(alice);
        vm.prank(owner); chronos.pause();

        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        chronos.buyShares(0, Chronos.Outcome.YES, 100e6);
    }

    function test_Pause_CloseTrading_NotReverted() public {
        _createMarket(alice);
        vm.prank(owner); chronos.pause();

        vm.warp(T_TRADE + 1);
        // should NOT revert
        chronos.closeTrading(0);

        Chronos.Market memory m = chronos.getMarket(0);
        assertEq(uint8(m.state), uint8(Chronos.MarketState.TradingClosed));
    }

    function test_Pause_MarkRefundable_NotReverted() public {
        _createMarket(alice);
        vm.prank(owner); chronos.pause();

        vm.warp(T_RESOLVE + 1);
        chronos.markRefundable(0); // must succeed
    }

    function test_Pause_ClaimRefund_NotReverted() public {
        uint256 id = _setupRefundable();
        vm.prank(owner); chronos.pause();

        vm.prank(alice);
        chronos.claimRefund(id); // must succeed while paused
    }

    function test_Pause_ClaimWinnings_NotReverted() public {
        uint256 id = _setupResolved();
        vm.prank(owner); chronos.pause();

        vm.prank(alice);
        chronos.claimWinnings(id); // must succeed while paused
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  ADMIN SETTERS
    // ═══════════════════════════════════════════════════════════════════════════

    function test_SetOracle_ZeroAddress_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(Chronos.InvalidAddress.selector);
        chronos.setOracle(address(0));
    }

    function test_SetOracle_Valid() public {
        address newOracle = makeAddr("newOracle");
        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(chronos));
        emit Chronos.OracleUpdated(oracle, newOracle);
        chronos.setOracle(newOracle);
        assertEq(chronos.oracle(), newOracle);
    }

    function test_SetOracle_NonOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        chronos.setOracle(makeAddr("x"));
    }

    function test_SetTreasury_ZeroAddress_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(Chronos.InvalidAddress.selector);
        chronos.setTreasury(address(0));
    }

    function test_SetTreasury_Valid() public {
        address newTreasury = makeAddr("newTreasury");
        vm.prank(owner);
        vm.expectEmit(false, false, false, true, address(chronos));
        emit Chronos.TreasuryUpdated(treasury, newTreasury);
        chronos.setTreasury(newTreasury);
        assertEq(chronos.treasury(), newTreasury);
    }

    function test_SetTreasury_NonOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        chronos.setTreasury(makeAddr("x"));
    }

    function test_SetFeeBps_Over1000_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(Chronos.InvalidFee.selector);
        chronos.setFeeBps(1001);
    }

    function test_SetFeeBps_Exactly1000_Succeeds() public {
        vm.prank(owner);
        chronos.setFeeBps(1000);
        assertEq(chronos.feeBps(), 1000);
    }

    function test_SetFeeBps_NonOwner_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        chronos.setFeeBps(100);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  FUZZ: buyShares amount
    // ═══════════════════════════════════════════════════════════════════════════

    function testFuzz_BuyShares_PoolAccounting(uint256 yesAmt, uint256 noAmt) public {
        yesAmt = bound(yesAmt, 1, 5_000e6);
        noAmt  = bound(noAmt,  1, 5_000e6);

        // Ensure alice and bob have enough
        usdc.mint(alice, yesAmt);
        usdc.mint(bob,   noAmt);

        uint256 id = _createMarket(carol);

        vm.prank(alice);
        chronos.buyShares(id, Chronos.Outcome.YES, yesAmt);
        vm.prank(bob);
        chronos.buyShares(id, Chronos.Outcome.NO, noAmt);

        Chronos.Market memory m = chronos.getMarket(id);
        assertEq(m.yesPool, yesAmt);
        assertEq(m.noPool,  noAmt);
        assertEq(usdc.balanceOf(address(chronos)), yesAmt + noAmt);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  INTEGRATION: full lifecycle — create, buy, close, resolve, claim, withdraw
    // ═══════════════════════════════════════════════════════════════════════════

    function test_Integration_FullLifecycle() public {
        // 1. Create market
        uint256 id = _createMarket(carol);

        // 2. Alice buys 200 USDC YES, Bob buys 800 USDC NO
        vm.prank(alice);
        chronos.buyShares(id, Chronos.Outcome.YES, 200e6);
        vm.prank(bob);
        chronos.buyShares(id, Chronos.Outcome.NO,  800e6);

        // 3. Advance past trading deadline and closeTrading
        vm.warp(T_TRADE + 1);
        chronos.closeTrading(id);

        // 4. Advance a bit and resolve YES
        vm.warp(T_TRADE + 2);
        vm.prank(oracle);
        chronos.resolveMarket(id, Chronos.Outcome.YES, "ipfs://evidence");

        // 5. Verify fee math before claim
        // gross = 200e6 * 1000e6 / 200e6 = 1000e6
        // profit = 800e6, fee = 800e6 * 500 / 10000 = 40e6
        // netPayout = 960e6
        (uint256 computedNet, uint256 computedFee) = chronos.computeWinnings(id, alice);
        assertEq(computedNet, 960e6);
        assertEq(computedFee,  40e6);

        // 6. Alice claims winnings
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        chronos.claimWinnings(id);

        uint256 aliceGain = usdc.balanceOf(alice) - aliceBefore;
        assertEq(aliceGain, 960e6,  "alice receives exactly netPayout");

        // 7. pendingFees == 40e6; treasury has received nothing yet
        assertEq(chronos.pendingFees(),        40e6);
        assertEq(usdc.balanceOf(treasury),     0);

        // 8. withdrawFees → treasury gets 40e6
        chronos.withdrawFees();
        assertEq(usdc.balanceOf(treasury),     40e6);
        assertEq(chronos.pendingFees(),        0);

        // 9. Contract balance check:
        // Started: 1000e6; paid alice 960e6, kept 40e6 as pendingFees → sent to treasury
        // Remaining in contract = 0 (all settled + fee paid out)
        assertEq(usdc.balanceOf(address(chronos)), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  INTEGRATION: refund lifecycle
    // ═══════════════════════════════════════════════════════════════════════════

    function test_Integration_RefundLifecycle() public {
        // 1. Create market, both sides buy shares
        uint256 id = _createMarket(carol);

        vm.prank(alice);
        chronos.buyShares(id, Chronos.Outcome.YES, 250e6);
        vm.prank(bob);
        chronos.buyShares(id, Chronos.Outcome.NO,  750e6);

        // 2. Advance past BOTH deadlines (oracle never resolves)
        vm.warp(T_RESOLVE + 1);

        // 3. Anyone can mark refundable
        chronos.markRefundable(id);
        Chronos.Market memory m = chronos.getMarket(id);
        assertEq(uint8(m.state), uint8(Chronos.MarketState.Refundable));

        // 4. Alice claims refund → gets back exact 250e6
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        chronos.claimRefund(id);
        assertEq(usdc.balanceOf(alice) - aliceBefore, 250e6);

        // 5. Bob claims refund → gets back exact 750e6
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.prank(bob);
        chronos.claimRefund(id);
        assertEq(usdc.balanceOf(bob) - bobBefore, 750e6);

        // 6. Contract should be empty
        assertEq(usdc.balanceOf(address(chronos)), 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  computeWinnings (view helper)
    // ═══════════════════════════════════════════════════════════════════════════

    function test_ComputeWinnings_ReturnsZeroBeforeResolve() public {
        uint256 id = _setupTradingClosed();
        (uint256 net, uint256 fee) = chronos.computeWinnings(id, alice);
        assertEq(net, 0);
        assertEq(fee, 0);
    }

    function test_ComputeWinnings_ReturnsZeroForLoser() public {
        uint256 id = _setupResolved(); // YES wins
        (uint256 net, uint256 fee) = chronos.computeWinnings(id, bob); // bob=NO
        assertEq(net, 0);
        assertEq(fee, 0);
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  renounceOwnership disabled
    // ═══════════════════════════════════════════════════════════════════════════

    function test_RenounceOwnership_Reverts() public {
        vm.prank(owner);
        vm.expectRevert(Chronos.RenounceOwnershipDisabled.selector);
        chronos.renounceOwnership();
    }

    // ═══════════════════════════════════════════════════════════════════════════
    //  marketExists guard
    // ═══════════════════════════════════════════════════════════════════════════

    function test_MarketDoesNotExist_Reverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Chronos.MarketDoesNotExist.selector, 99));
        chronos.buyShares(99, Chronos.Outcome.YES, 100e6);
    }
}
