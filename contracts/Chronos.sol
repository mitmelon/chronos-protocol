// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @dev Pause policy — consistent allowlist design:
/// BLOCKED while paused (fund entry / new commitments):
///   - createMarket, buyShares, resolveMarket
/// ALLOWED while paused (non-custodial exits / user-protective paths):
///   - closeTrading     (permissionless time transition, not fund entry)
///   - markRefundable   (oracle-miss emergency exit — MUST remain open)
///   - claimWinnings    (winners must always be able to withdraw)
///   - claimRefund      (oracle-miss refund — MUST remain open)
///   - withdrawFees     (treasury pull — decoupled from user claims)
///   - sweepUnclaimed   (owner emergency — must remain open)
/// This is intentional: user fund-exit paths are NEVER blocked by pause,
/// only fund-entry and new-commitment paths are.
contract Chronos is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Outcome {
        UNRESOLVED,
        YES,
        NO
    }

    enum MarketState {
        Open,
        TradingClosed,
        Resolved,
        Refundable,
        Settled
    }

    struct Market {
        string question;
        string resolutionCriteria;
        uint64 tradingDeadline;
        uint64 resolutionDeadline;
        uint256 yesPool;
        uint256 noPool;
        uint256 totalPool;
        uint256 settledAmount; // accumulated netPayouts + fees paid out
        Outcome outcome;
        MarketState state;
        uint64 resolvedAt;
        string evidenceURI;
        bool swept;
        address creator;
        uint256 feeBps;
    }

    error InvalidAddress();
    error InvalidFee();
    error InvalidGracePeriod();
    error InvalidQuestion();
    error InvalidCriteria();
    error InvalidDeadline();
    error InvalidOutcome();
    error MarketDoesNotExist(uint256 id);
    error InvalidMarketState(uint8 current, uint8 expected);
    error TradingOpen();
    error TradingClosed_();
    error AlreadyClaimed();
    error NoShares();
    error NoUnclaimed();
    error AlreadySwept();
    error GracePeriodNotElapsed();
    error RenounceOwnershipDisabled();
    error InsufficientUSDCReserves();

    event MarketCreated(
        uint256 indexed marketId,
        address indexed creator,
        string question,
        uint64 tradingDeadline,
        uint64 resolutionDeadline
    );
    event SharesPurchased(uint256 indexed marketId, address indexed buyer, uint8 outcome, uint256 amount);
    event TradingClosed(uint256 indexed marketId, uint256 totalPool);
    event MarketResolved(uint256 indexed marketId, uint8 outcome, string evidenceURI, uint64 timestamp);
    event MarketRefundable(uint256 indexed marketId);
    event WinningsClaimed(
        uint256 indexed marketId,
        address indexed claimant,
        uint256 netPayout,
        uint256 originalStake,
        uint256 profit,
        uint256 fee
    );
    event FeePaid(uint256 indexed marketId, address treasury, uint256 amount);
    event FeesWithdrawn(address treasury, uint256 amount);
    event RefundClaimed(uint256 indexed marketId, address indexed claimant, uint256 amount);
    event UnclaimedSwept(uint256 indexed marketId, address treasury, uint256 amount);
    event OracleUpdated(address oldOracle, address newOracle);
    event TreasuryUpdated(address oldTreasury, address newTreasury);
    event FeeUpdated(uint256 oldBps, uint256 newBps);
    event GracePeriodUpdated(uint256 oldPeriod, uint256 newPeriod);
    event TokensRescued(address token, address to, uint256 amount);

    uint256 public marketCount;
    mapping(uint256 => Market) public markets;
    mapping(uint256 => mapping(address => uint256)) public yesShares;
    mapping(uint256 => mapping(address => uint256)) public noShares;
    mapping(uint256 => mapping(address => bool)) public claimed;

    address public oracle;
    address public treasury;
    uint256 public feeBps; // 500 default (5%)
    uint256 public gracePeriod; // 15552000 default (180 days)
    uint256 public pendingFees;

    IERC20 public immutable usdc;

    modifier onlyOracle() {
        if (msg.sender != oracle) revert InvalidAddress();
        _;
    }

    modifier marketExists(uint256 id) {
        if (id >= marketCount) revert MarketDoesNotExist(id);
        _;
    }

    constructor(
        address _usdc,
        address _oracle,
        address _treasury,
        uint256 _feeBps,
        uint256 _gracePeriod,
        address initialOwner
    ) Ownable(initialOwner) {
        if (_usdc == address(0) || _oracle == address(0) || _treasury == address(0)) revert InvalidAddress();
        if (initialOwner == address(0)) revert InvalidAddress();
        if (_feeBps > 1000) revert InvalidFee();
        if (_gracePeriod < 1 days) revert InvalidGracePeriod();

        usdc = IERC20(_usdc);
        oracle = _oracle;
        treasury = _treasury;
        feeBps = _feeBps;
        gracePeriod = _gracePeriod;
    }

    function createMarket(
        string calldata question,
        string calldata resolutionCriteria,
        uint64 tradingDeadline,
        uint64 resolutionDeadline
    ) external whenNotPaused returns (uint256 marketId) {
        uint256 qLen = bytes(question).length;
        uint256 cLen = bytes(resolutionCriteria).length;

        if (qLen == 0 || qLen > 1024) revert InvalidQuestion();
        if (cLen == 0 || cLen > 4096) revert InvalidCriteria();
        if (tradingDeadline <= block.timestamp || resolutionDeadline <= tradingDeadline) revert InvalidDeadline();

        marketId = marketCount;
        marketCount = marketId + 1;

        Market storage m = markets[marketId];
        m.question = question;
        m.resolutionCriteria = resolutionCriteria;
        m.tradingDeadline = tradingDeadline;
        m.resolutionDeadline = resolutionDeadline;
        m.outcome = Outcome.UNRESOLVED;
        m.state = MarketState.Open;
        m.creator = msg.sender;
        m.feeBps = feeBps;

        emit MarketCreated(marketId, msg.sender, question, tradingDeadline, resolutionDeadline);
    }

    function buyShares(
        uint256 marketId,
        Outcome outcome,
        uint256 amount
    ) external whenNotPaused nonReentrant marketExists(marketId) {
        Market storage m = markets[marketId];

        if (m.state != MarketState.Open) revert InvalidMarketState(uint8(m.state), uint8(MarketState.Open));
        if (block.timestamp >= m.tradingDeadline) revert TradingClosed_();
        if (outcome == Outcome.UNRESOLVED) revert InvalidOutcome();
        if (amount == 0) revert NoShares();

        // CEI: update pools and user shares before external transfer.
        if (outcome == Outcome.YES) {
            m.yesPool += amount;
            yesShares[marketId][msg.sender] += amount;
        } else {
            m.noPool += amount;
            noShares[marketId][msg.sender] += amount;
        }

        usdc.safeTransferFrom(msg.sender, address(this), amount);

        emit SharesPurchased(marketId, msg.sender, uint8(outcome), amount);
    }

    function closeTrading(uint256 marketId) external marketExists(marketId) {
        Market storage m = markets[marketId];

        if (m.state != MarketState.Open) revert InvalidMarketState(uint8(m.state), uint8(MarketState.Open));
        if (block.timestamp < m.tradingDeadline) revert TradingOpen();

        _closeTrading(marketId, m);
    }

    function resolveMarket(
        uint256 marketId,
        Outcome outcome,
        string calldata evidenceURI
    ) external onlyOracle whenNotPaused marketExists(marketId) {
        Market storage m = markets[marketId];

        if (m.state == MarketState.Open && block.timestamp >= m.tradingDeadline) {
            _closeTrading(marketId, m);
        }

        if (m.state != MarketState.TradingClosed) {
            revert InvalidMarketState(uint8(m.state), uint8(MarketState.TradingClosed));
        }
        if (outcome == Outcome.UNRESOLVED) revert InvalidOutcome();
        if (block.timestamp > m.resolutionDeadline) revert InvalidDeadline();

        m.outcome = outcome;
        m.state = MarketState.Resolved;
        m.resolvedAt = uint64(block.timestamp);
        m.evidenceURI = evidenceURI;

        emit MarketResolved(marketId, uint8(outcome), evidenceURI, uint64(block.timestamp));
    }

    function markRefundable(uint256 marketId) external marketExists(marketId) {
        Market storage m = markets[marketId];

        if (m.state != MarketState.Open && m.state != MarketState.TradingClosed) {
            revert InvalidMarketState(uint8(m.state), uint8(MarketState.TradingClosed));
        }
        if (block.timestamp <= m.resolutionDeadline) revert InvalidDeadline();

        m.state = MarketState.Refundable;

        emit MarketRefundable(marketId);
    }

    function claimWinnings(uint256 marketId) external nonReentrant marketExists(marketId) {
        Market storage m = markets[marketId];

        if (m.state != MarketState.Resolved) revert InvalidMarketState(uint8(m.state), uint8(MarketState.Resolved));
        if (claimed[marketId][msg.sender]) revert AlreadyClaimed();
        if (m.outcome == Outcome.UNRESOLVED) revert InvalidOutcome();

        uint256 winnerShares = m.outcome == Outcome.YES ? yesShares[marketId][msg.sender] : noShares[marketId][msg.sender];
        if (winnerShares == 0) revert NoShares();

        uint256 winningPool = m.outcome == Outcome.YES ? m.yesPool : m.noPool;

        // Fee model (exact):
        // grossPayout   = winnerShares * totalPool / winningPool
        // originalStake = winnerShares
        // profit        = grossPayout - winnerShares
        // fee           = profit * feeBps / 10_000
        // netPayout     = grossPayout - fee
        uint256 grossPayout = (winnerShares * m.totalPool) / winningPool;
        uint256 profit = grossPayout - winnerShares;
        uint256 fee = (profit * m.feeBps) / 10_000;
        uint256 netPayout = grossPayout - fee;

        // CEI before transfers.
        claimed[marketId][msg.sender] = true;
        m.settledAmount += (netPayout + fee);

        if (fee > 0) {
            pendingFees += fee;
            emit FeePaid(marketId, treasury, fee);
        }

        usdc.safeTransfer(msg.sender, netPayout);

        emit WinningsClaimed(marketId, msg.sender, netPayout, winnerShares, profit, fee);
    }

    function claimRefund(uint256 marketId) external nonReentrant marketExists(marketId) {
        Market storage m = markets[marketId];

        if (m.state != MarketState.Refundable) {
            revert InvalidMarketState(uint8(m.state), uint8(MarketState.Refundable));
        }
        if (claimed[marketId][msg.sender]) revert AlreadyClaimed();

        uint256 amount = yesShares[marketId][msg.sender] + noShares[marketId][msg.sender];
        if (amount == 0) revert NoShares();

        // CEI before transfer.
        claimed[marketId][msg.sender] = true;

        usdc.safeTransfer(msg.sender, amount);

        emit RefundClaimed(marketId, msg.sender, amount);
    }

    function sweepUnclaimed(uint256 marketId) external onlyOwner nonReentrant marketExists(marketId) {
        Market storage m = markets[marketId];

        if (m.state != MarketState.Resolved) revert InvalidMarketState(uint8(m.state), uint8(MarketState.Resolved));
        if (m.swept) revert AlreadySwept();
        if (block.timestamp < uint256(m.resolvedAt) + gracePeriod) revert GracePeriodNotElapsed();

        uint256 remaining = m.totalPool - m.settledAmount;
        if (remaining == 0) revert NoUnclaimed();

        // CEI before transfer.
        m.swept = true;
        m.state = MarketState.Settled;

        usdc.safeTransfer(treasury, remaining);

        emit UnclaimedSwept(marketId, treasury, remaining);
    }

    function withdrawFees() external nonReentrant {
        uint256 amount = pendingFees;
        if (amount == 0) revert NoUnclaimed();

        pendingFees = 0;
        usdc.safeTransfer(treasury, amount);

        emit FeesWithdrawn(treasury, amount);
    }

    function setOracle(address _oracle) external onlyOwner {
        if (_oracle == address(0)) revert InvalidAddress();

        address oldOracle = oracle;
        oracle = _oracle;

        emit OracleUpdated(oldOracle, _oracle);
    }

    function setTreasury(address _treasury) external onlyOwner {
        if (_treasury == address(0)) revert InvalidAddress();

        address oldTreasury = treasury;
        treasury = _treasury;

        emit TreasuryUpdated(oldTreasury, _treasury);
    }

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        if (_feeBps > 1000) revert InvalidFee();

        uint256 oldBps = feeBps;
        feeBps = _feeBps;

        emit FeeUpdated(oldBps, _feeBps);
    }

    function setGracePeriod(uint256 _gracePeriod) external onlyOwner {
        if (_gracePeriod < 1 days) revert InvalidGracePeriod();

        uint256 oldPeriod = gracePeriod;
        gracePeriod = _gracePeriod;

        emit GracePeriodUpdated(oldPeriod, _gracePeriod);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function rescueTokens(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0) || to == address(0)) revert InvalidAddress();

        if (token == address(usdc)) {
            uint256 totalActivePools;

            for (uint256 i = 0; i < marketCount; ++i) {
                Market storage m = markets[i];

                if (m.state == MarketState.Open) {
                    totalActivePools += (m.yesPool + m.noPool);
                } else if (m.state == MarketState.TradingClosed) {
                    totalActivePools += m.totalPool;
                } else if (m.state == MarketState.Resolved || m.state == MarketState.Refundable) {
                    totalActivePools += (m.yesPool + m.noPool - m.settledAmount);
                }
            }

            uint256 currentBalance = usdc.balanceOf(address(this));
            if (currentBalance < amount || (currentBalance - amount) < (totalActivePools + pendingFees)) {
                revert InsufficientUSDCReserves();
            }
        }

        IERC20(token).safeTransfer(to, amount);

        emit TokensRescued(token, to, amount);
    }

    function getMarket(uint256 marketId) external view marketExists(marketId) returns (Market memory) {
        return markets[marketId];
    }

    function getShares(uint256 marketId, address user) external view marketExists(marketId) returns (uint256 yesAmt, uint256 noAmt) {
        yesAmt = yesShares[marketId][user];
        noAmt = noShares[marketId][user];
    }

    function computeWinnings(
        uint256 marketId,
        address user
    ) external view marketExists(marketId) returns (uint256 netPayout, uint256 feeAmount) {
        Market storage m = markets[marketId];

        if (m.state != MarketState.Resolved || m.outcome == Outcome.UNRESOLVED) {
            return (0, 0);
        }

        uint256 winnerShares = m.outcome == Outcome.YES ? yesShares[marketId][user] : noShares[marketId][user];
        if (winnerShares == 0) {
            return (0, 0);
        }

        uint256 winningPool = m.outcome == Outcome.YES ? m.yesPool : m.noPool;
        if (winningPool == 0) {
            return (0, 0);
        }

        uint256 grossPayout = (winnerShares * m.totalPool) / winningPool;
        uint256 profit = grossPayout - winnerShares;
        feeAmount = (profit * m.feeBps) / 10_000;
        netPayout = grossPayout - feeAmount;
    }

    function renounceOwnership() public view override onlyOwner {
        revert RenounceOwnershipDisabled();
    }

    function _closeTrading(uint256 marketId, Market storage m) internal {
        m.state = MarketState.TradingClosed;
        m.totalPool = m.yesPool + m.noPool;

        emit TradingClosed(marketId, m.totalPool);
    }
}
