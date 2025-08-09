// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/math/Math.sol";

/**
 * @title DeFiLendingProtocol
 * @dev A decentralized lending and borrowing protocol with dynamic interest rates
 */
contract DeFiLendingProtocol is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    using Math for uint256;

    struct Market {
        IERC20 token;
        uint256 totalSupply;
        uint256 totalBorrow;
        uint256 supplyIndex;
        uint256 borrowIndex;
        uint256 lastUpdateTime;
        uint256 reserveFactor; // Percentage of interest that goes to reserves (basis points)
        bool isActive;
    }

    struct UserAccount {
        uint256 supplied;
        uint256 borrowed;
        uint256 supplyIndex;
        uint256 borrowIndex;
    }

    // Markets mapping: token address => Market
    mapping(address => Market) public markets;
    
    // User balances: user => token => UserAccount
    mapping(address => mapping(address => UserAccount)) public userAccounts;
    
    // Supported tokens
    address[] public supportedTokens;
    
    // Interest rate model parameters
    uint256 public constant BASE_RATE = 2e16; // 2% base rate
    uint256 public constant MULTIPLIER = 10e16; // 10% multiplier
    uint256 public constant JUMP_MULTIPLIER = 109e16; // 109% jump multiplier
    uint256 public constant OPTIMAL_UTILIZATION = 80e16; // 80% optimal utilization
    uint256 public constant BLOCKS_PER_YEAR = 2628000; // Approximate blocks per year
    
    // Events
    event MarketAdded(address indexed token);
    event Supply(address indexed user, address indexed token, uint256 amount);
    event Redeem(address indexed user, address indexed token, uint256 amount);
    event Borrow(address indexed user, address indexed token, uint256 amount);
    event Repay(address indexed user, address indexed token, uint256 amount);
    event InterestAccrued(address indexed token, uint256 supplyIndex, uint256 borrowIndex);

    constructor() {}

    /**
     * @dev Add a new token market
     */
    function addMarket(address _token, uint256 _reserveFactor) external onlyOwner {
        require(_token != address(0), "Invalid token address");
        require(!markets[_token].isActive, "Market already exists");
        require(_reserveFactor <= 5000, "Reserve factor too high"); // Max 50%

        markets[_token] = Market({
            token: IERC20(_token),
            totalSupply: 0,
            totalBorrow: 0,
            supplyIndex: 1e18,
            borrowIndex: 1e18,
            lastUpdateTime: block.timestamp,
            reserveFactor: _reserveFactor,
            isActive: true
        });

        supportedTokens.push(_token);
        emit MarketAdded(_token);
    }

    /**
     * @dev Supply tokens to earn interest
     */
    function supply(address _token, uint256 _amount) external nonReentrant {
        require(_amount > 0, "Amount must be greater than 0");
        require(markets[_token].isActive, "Market not active");

        accrueInterest(_token);

        Market storage market = markets[_token];
        UserAccount storage account = userAccounts[msg.sender][_token];

        // Update user's supplied balance
        if (account.supplied > 0) {
            uint256 accruedInterest = (account.supplied * market.supplyIndex) / account.supplyIndex;
            account.supplied = accruedInterest;
        }
        
        account.supplied += _amount;
        account.supplyIndex = market.supplyIndex;

        // Update market totals
        market.totalSupply += _amount;

        // Transfer tokens from user
        market.token.safeTransferFrom(msg.sender, address(this), _amount);

        emit Supply(msg.sender, _token, _amount);
    }

    /**
     * @dev Redeem supplied tokens plus interest
     */
    function redeem(address _token, uint256 _amount) external nonReentrant {
        require(_amount > 0, "Amount must be greater than 0");
        require(markets[_token].isActive, "Market not active");

        accrueInterest(_token);

        Market storage market = markets[_token];
        UserAccount storage account = userAccounts[msg.sender][_token];

        // Calculate user's current balance with accrued interest
        uint256 currentBalance = (account.supplied * market.supplyIndex) / account.supplyIndex;
        require(currentBalance >= _amount, "Insufficient balance");

        // Check if there's enough liquidity
        uint256 availableLiquidity = market.totalSupply - market.totalBorrow;
        require(availableLiquidity >= _amount, "Insufficient liquidity");

        // Update user's balance
        account.supplied = currentBalance - _amount;
        account.supplyIndex = market.supplyIndex;

        // Update market totals
        market.totalSupply -= _amount;

        // Transfer tokens to user
        market.token.safeTransfer(msg.sender, _amount);

        emit Redeem(msg.sender, _token, _amount);
    }

    /**
     * @dev Borrow tokens
     */
    function borrow(address _token, uint256 _amount) external nonReentrant {
        require(_amount > 0, "Amount must be greater than 0");
        require(markets[_token].isActive, "Market not active");

        accrueInterest(_token);

        Market storage market = markets[_token];
        UserAccount storage account = userAccounts[msg.sender][_token];

        // Check if there's enough liquidity
        uint256 availableLiquidity = market.totalSupply - market.totalBorrow;
        require(availableLiquidity >= _amount, "Insufficient liquidity");

        // Update user's borrowed balance
        if (account.borrowed > 0) {
            uint256 accruedInterest = (account.borrowed * market.borrowIndex) / account.borrowIndex;
            account.borrowed = accruedInterest;
        }
        
        account.borrowed += _amount;
        account.borrowIndex = market.borrowIndex;

        // Update market totals
        market.totalBorrow += _amount;

        // Transfer tokens to user
        market.token.safeTransfer(msg.sender, _amount);

        emit Borrow(msg.sender, _token, _amount);
    }

    /**
     * @dev Repay borrowed tokens
     */
    function repay(address _token, uint256 _amount) external nonReentrant {
        require(_amount > 0, "Amount must be greater than 0");
        require(markets[_token].isActive, "Market not active");

        accrueInterest(_token);

        Market storage market = markets[_token];
        UserAccount storage account = userAccounts[msg.sender][_token];

        // Calculate current debt with accrued interest
        uint256 currentDebt = (account.borrowed * market.borrowIndex) / account.borrowIndex;
        
        // Don't allow repaying more than owed
        uint256 repayAmount = _amount > currentDebt ? currentDebt : _amount;
        
        // Update user's borrowed balance
        account.borrowed = currentDebt - repayAmount;
        account.borrowIndex = market.borrowIndex;

        // Update market totals
        market.totalBorrow -= repayAmount;

        // Transfer tokens from user
        market.token.safeTransferFrom(msg.sender, address(this), repayAmount);

        emit Repay(msg.sender, _token, repayAmount);
    }

    /**
     * @dev Accrue interest for a market
     */
    function accrueInterest(address _token) public {
        Market storage market = markets[_token];
        
        if (block.timestamp == market.lastUpdateTime) {
            return; // No time has passed
        }

        uint256 timeElapsed = block.timestamp - market.lastUpdateTime;
        
        if (market.totalBorrow == 0) {
            market.lastUpdateTime = block.timestamp;
            return; // No borrows to accrue interest on
        }

        // Calculate interest rates
        (uint256 supplyRate, uint256 borrowRate) = getInterestRates(_token);
        
        // Calculate interest accrued
        uint256 borrowInterest = (market.totalBorrow * borrowRate * timeElapsed) / (365 days * 1e18);
        uint256 reserves = (borrowInterest * market.reserveFactor) / 10000;
        uint256 supplyInterest = borrowInterest - reserves;

        // Update indices
        market.borrowIndex = market.borrowIndex + (market.borrowIndex * borrowRate * timeElapsed) / (365 days * 1e18);
        
        if (market.totalSupply > 0) {
            market.supplyIndex = market.supplyIndex + (market.supplyIndex * supplyInterest) / market.totalSupply;
        }

        // Update total borrow (includes accrued interest)
        market.totalBorrow += borrowInterest;
        market.lastUpdateTime = block.timestamp;

        emit InterestAccrued(_token, market.supplyIndex, market.borrowIndex);
    }

    /**
     * @dev Calculate current supply and borrow rates
     */
    function getInterestRates(address _token) public view returns (uint256 supplyRate, uint256 borrowRate) {
        Market memory market = markets[_token];
        
        if (market.totalSupply == 0) {
            return (0, BASE_RATE);
        }

        uint256 utilization = (market.totalBorrow * 1e18) / market.totalSupply;
        
        if (utilization <= OPTIMAL_UTILIZATION) {
            // Below optimal utilization
            borrowRate = BASE_RATE + (utilization * MULTIPLIER) / 1e18;
        } else {
            // Above optimal utilization
            uint256 excessUtilization = utilization - OPTIMAL_UTILIZATION;
            borrowRate = BASE_RATE + MULTIPLIER + (excessUtilization * JUMP_MULTIPLIER) / (1e18 - OPTIMAL_UTILIZATION);
        }

        // Supply rate = borrow rate * utilization * (1 - reserve factor)
        supplyRate = (borrowRate * utilization * (10000 - market.reserveFactor)) / (1e18 * 10000);
    }

    /**
     * @dev Get user's current balances including accrued interest
     */
    function getUserBalance(address _user, address _token) external view returns (uint256 supplied, uint256 borrowed) {
        Market memory market = markets[_token];
        UserAccount memory account = userAccounts[_user][_token];

        if (account.supplied > 0) {
            supplied = (account.supplied * market.supplyIndex) / account.supplyIndex;
        }

        if (account.borrowed > 0) {
            borrowed = (account.borrowed * market.borrowIndex) / account.borrowIndex;
        }
    }

    /**
     * @dev Get market information
     */
    function getMarketInfo(address _token) external view returns (
        uint256 totalSupply,
        uint256 totalBorrow,
        uint256 supplyRate,
        uint256 borrowRate,
        uint256 utilization
    ) {
        Market memory market = markets[_token];
        totalSupply = market.totalSupply;
        totalBorrow = market.totalBorrow;
        (supplyRate, borrowRate) = getInterestRates(_token);
        
        if (totalSupply > 0) {
            utilization = (totalBorrow * 1e18) / totalSupply;
        }
    }

    /**
     * @dev Get all supported tokens
     */
    function getSupportedTokens() external view returns (address[] memory) {
        return supportedTokens;
    }
}
