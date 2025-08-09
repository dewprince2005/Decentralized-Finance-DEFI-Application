// test/DeFiLendingProtocol.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

describe("DeFi Lending Protocol", function () {
  let lendingProtocol;
  let usdc, weth, wbtc;
  let owner, alice, bob, charlie;
  
  const USDC_DECIMALS = 6;
  const WETH_DECIMALS = 18;
  const WBTC_DECIMALS = 8;

  beforeEach(async function () {
    [owner, alice, bob, charlie] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
    weth = await MockERC20.deploy("Wrapped Ether", "WETH", WETH_DECIMALS);
    wbtc = await MockERC20.deploy("Wrapped Bitcoin", "WBTC", WBTC_DECIMALS);

    // Deploy lending protocol
    const DeFiLendingProtocol = await ethers.getContractFactory("DeFiLendingProtocol");
    lendingProtocol = await DeFiLendingProtocol.deploy();

    // Add markets
    await lendingProtocol.addMarket(usdc.address, 1000); // 10% reserve factor
    await lendingProtocol.addMarket(weth.address, 1500); // 15% reserve factor
    await lendingProtocol.addMarket(wbtc.address, 2000); // 20% reserve factor

    // Mint tokens to users
    const usdcAmount = ethers.utils.parseUnits("100000", USDC_DECIMALS);
    const wethAmount = ethers.utils.parseUnits("100", WETH_DECIMALS);
    const wbtcAmount = ethers.utils.parseUnits("10", WBTC_DECIMALS);

    await usdc.mint(alice.address, usdcAmount);
    await usdc.mint(bob.address, usdcAmount);
    await weth.mint(alice.address, wethAmount);
    await weth.mint(bob.address, wethAmount);
    await wbtc.mint(alice.address, wbtcAmount);
    await wbtc.mint(bob.address, wbtcAmount);
  });

  describe("Market Management", function () {
    it("Should add markets correctly", async function () {
      const supportedTokens = await lendingProtocol.getSupportedTokens();
      expect(supportedTokens).to.include(usdc.address);
      expect(supportedTokens).to.include(weth.address);
      expect(supportedTokens).to.include(wbtc.address);
    });

    it("Should not allow duplicate markets", async function () {
      await expect(
        lendingProtocol.addMarket(usdc.address, 1000)
      ).to.be.revertedWith("Market already exists");
    });

    it("Should not allow high reserve factors", async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const newToken = await MockERC20.deploy("New Token", "NEW", 18);
      
      await expect(
        lendingProtocol.addMarket(newToken.address, 6000) // 60%
      ).to.be.revertedWith("Reserve factor too high");
    });
  });

  describe("Supply Operations", function () {
    it("Should allow users to supply tokens", async function () {
      const supplyAmount = ethers.utils.parseUnits("1000", USDC_DECIMALS);
      
      // Approve and supply
      await usdc.connect(alice).approve(lendingProtocol.address, supplyAmount);
      await lendingProtocol.connect(alice).supply(usdc.address, supplyAmount);

      // Check balances
      const userBalance = await lendingProtocol.getUserBalance(alice.address, usdc.address);
      expect(userBalance.supplied).to.equal(supplyAmount);

      const marketInfo = await lendingProtocol.getMarketInfo(usdc.address);
      expect(marketInfo.totalSupply).to.equal(supplyAmount);
    });

    it("Should accrue interest on supplied tokens", async function () {
      const supplyAmount = ethers.utils.parseUnits("1000", USDC_DECIMALS);
      const borrowAmount = ethers.utils.parseUnits("500", USDC_DECIMALS);

      // Alice supplies
      await usdc.connect(alice).approve(lendingProtocol.address, supplyAmount);
      await lendingProtocol.connect(alice).supply(usdc.address, supplyAmount);

      // Bob borrows (creates utilization)
      await lendingProtocol.connect(bob).borrow(usdc.address, borrowAmount);

      // Fast forward time
      await time.increase(365 * 24 * 60 * 60); // 1 year

      // Accrue interest
      await lendingProtocol.accrueInterest(usdc.address);

      // Check if Alice's balance increased
      const userBalance = await lendingProtocol.getUserBalance(alice.address, usdc.address);
      expect(userBalance.supplied).to.be.gt(supplyAmount);
    });

    it("Should emit Supply event", async function () {
      const supplyAmount = ethers.utils.parseUnits("1000", USDC_DECIMALS);
      
      await usdc.connect(alice).approve(lendingProtocol.address, supplyAmount);
      
      await expect(
        lendingProtocol.connect(alice).supply(usdc.address, supplyAmount)
      ).to.emit(lendingProtocol, "Supply")
       .withArgs(alice.address, usdc.address, supplyAmount);
    });
  });

  describe("Redeem Operations", function () {
    beforeEach(async function () {
      // Alice supplies USDC
      const supplyAmount = ethers.utils.parseUnits("1000", USDC_DECIMALS);
      await usdc.connect(alice).approve(lendingProtocol.address, supplyAmount);
      await lendingProtocol.connect(alice).supply(usdc.address, supplyAmount);
    });

    it("Should allow users to redeem supplied tokens", async function () {
      const redeemAmount = ethers.utils.parseUnits("500", USDC_DECIMALS);
      const initialBalance = await usdc.balanceOf(alice.address);

      await lendingProtocol.connect(alice).redeem(usdc.address, redeemAmount);

      const finalBalance = await usdc.balanceOf(alice.address);
      expect(finalBalance.sub(initialBalance)).to.equal(redeemAmount);
    });

    it("Should not allow redeeming more than supplied", async function () {
      const redeemAmount = ethers.utils.parseUnits("2000", USDC_DECIMALS);
      
      await expect(
        lendingProtocol.connect(alice).redeem(usdc.address, redeemAmount)
      ).to.be.revertedWith("Insufficient balance");
    });

    it("Should not allow redeeming when insufficient liquidity", async function () {
      // Bob borrows almost all supplied tokens
      const borrowAmount = ethers.utils.parseUnits("999", USDC_DECIMALS);
      await lendingProtocol.connect(bob).borrow(usdc.address, borrowAmount);

      const redeemAmount = ethers.utils.parseUnits("100", USDC_DECIMALS);
      
      await expect(
        lendingProtocol.connect(alice).redeem(usdc.address, redeemAmount)
      ).to.be.revertedWith("Insufficient liquidity");
    });
  });

  describe("Borrow Operations", function () {
    beforeEach(async function () {
      // Alice supplies USDC to provide liquidity
      const supplyAmount = ethers.utils.parseUnits("10000", USDC_DECIMALS);
      await usdc.connect(alice).approve(lendingProtocol.address, supplyAmount);
      await lendingProtocol.connect(alice).supply(usdc.address, supplyAmount);
    });

    it("Should allow users to borrow tokens", async function () {
      const borrowAmount = ethers.utils.parseUnits("1000", USDC_DECIMALS);
      const initialBalance = await usdc.balanceOf(bob.address);

      await lendingProtocol.connect(bob).borrow(usdc.address, borrowAmount);

      const finalBalance = await usdc.balanceOf(bob.address);
      expect(finalBalance.sub(initialBalance)).to.equal(borrowAmount);

      const userBalance = await lendingProtocol.getUserBalance(bob.address, usdc.address);
      expect(userBalance.borrowed).to.equal(borrowAmount);
    });

    it("Should accrue interest on borrowed tokens", async function () {
      const borrowAmount = ethers.utils.parseUnits("1000", USDC_DECIMALS);
      
      await lendingProtocol.connect(bob).borrow(usdc.address, borrowAmount);

      // Fast forward time
      await time.increase(365 * 24 * 60 * 60); // 1 year

      // Accrue interest
      await lendingProtocol.accrueInterest(usdc.address);

      // Check if Bob's debt increased
      const userBalance = await lendingProtocol.getUserBalance(bob.address, usdc.address);
      expect(userBalance.borrowed).to.be.gt(borrowAmount);
    });

    it("Should not allow borrowing more than available liquidity", async function () {
      const borrowAmount = ethers.utils.parseUnits("20000", USDC_DECIMALS);
      
      await expect(
        lendingProtocol.connect(bob).borrow(usdc.address, borrowAmount)
      ).to.be.revertedWith("Insufficient liquidity");
    });
  });

  describe("Repay Operations", function () {
    beforeEach(async function () {
      // Setup: Alice supplies, Bob borrows
      const supplyAmount = ethers.utils.parseUnits("10000", USDC_DECIMALS);
      await usdc.connect(alice).approve(lendingProtocol.address, supplyAmount);
      await lendingProtocol.connect(alice).supply(usdc.address, supplyAmount);

      const borrowAmount = ethers.utils.parseUnits("1000", USDC_DECIMALS);
      await lendingProtocol.connect(bob).borrow(usdc.address, borrowAmount);
    });

    it("Should allow users to repay borrowed tokens", async function () {
      const repayAmount = ethers.utils.parseUnits("500", USDC_DECIMALS);
      
      await usdc.connect(bob).approve(lendingProtocol.address, repayAmount);
      await lendingProtocol.connect(bob).repay(usdc.address, repayAmount);

      const userBalance = await lendingProtocol.getUserBalance(bob.address, usdc.address);
      expect(userBalance.borrowed).to.equal(
        ethers.utils.parseUnits("500", USDC_DECIMALS)
      );
    });

    it("Should not allow repaying more than borrowed", async function () {
      const repayAmount = ethers.utils.parseUnits("2000", USDC_DECIMALS);
      
      await usdc.connect(bob).approve(lendingProtocol.address, repayAmount);
      
      // Should only repay the actual debt amount
      await lendingProtocol.connect(bob).repay(usdc.address, repayAmount);
      
      const userBalance = await lendingProtocol.getUserBalance(bob.address, usdc.address);
      expect(userBalance.borrowed).to.equal(0);
    });
  });

  describe("Interest Rate Model", function () {
    it("Should calculate interest rates correctly at low utilization", async function () {
      // Supply 10000 USDC
      const supplyAmount = ethers.utils.parseUnits("10000", USDC_DECIMALS);
      await usdc.connect(alice).approve(lendingProtocol.address, supplyAmount);
      await lendingProtocol.connect(alice).supply(usdc.address, supplyAmount);

      // Borrow 1000 USDC (10% utilization)
      const borrowAmount = ethers.utils.parseUnits("1000", USDC_DECIMALS);
      await lendingProtocol.connect(bob).borrow(usdc.address, borrowAmount);

      const rates = await lendingProtocol.getInterestRates(usdc.address);
      
      // At 10% utilization, should be in the linear portion
      expect(rates.borrowRate).to.be.gt(ethers.utils.parseEther("0.02")); // > 2%
      expect(rates.supplyRate).to.be.gt(0);
      expect(rates.supplyRate).to.be.lt(rates.borrowRate);
    });

    it("Should calculate interest rates correctly at high utilization", async function () {
      // Supply 10000 USDC
      const supplyAmount = ethers.utils.parseUnits("10000", USDC_DECIMALS);
      await usdc.connect(alice).approve(lendingProtocol.address, supplyAmount);
      await lendingProtocol.connect(alice).supply(usdc.address, supplyAmount);

      // Borrow 9000 USDC (90% utilization - above optimal)
      const borrowAmount = ethers.utils.parseUnits("9000", USDC_DECIMALS);
      await lendingProtocol.connect(bob).borrow(usdc.address, borrowAmount);

      const rates = await lendingProtocol.getInterestRates(usdc.address);
      
      // At 90% utilization, should be in the jump portion (higher rates)
      expect(rates.borrowRate).to.be.gt(ethers.utils.parseEther("0.1")); // > 10%
    });
  });

  describe("Market Information", function () {
    it("Should return correct market information", async function () {
      // Supply and borrow to create utilization
      const supplyAmount = ethers.utils.parseUnits("10000", USDC_DECIMALS);
      const borrowAmount = ethers.utils.parseUnits("3000", USDC_DECIMALS);

      await usdc.connect(alice).approve(lendingProtocol.address, supplyAmount);
      await lendingProtocol.connect(alice).supply(usdc.address, supplyAmount);
      await lendingProtocol.connect(bob).borrow(usdc.address, borrowAmount);

      const marketInfo = await lendingProtocol.getMarketInfo(usdc.address);
      
      expect(marketInfo.totalSupply).to.equal(supplyAmount);
      expect(marketInfo.totalBorrow).to.equal(borrowAmount);
      expect(marketInfo.utilization).to.equal(ethers.utils.parseEther("0.3")); // 30%
      expect(marketInfo.supplyRate).to.be.gt(0);
      expect(marketInfo.borrowRate).to.be.gt(0);
    });
  });

  describe("Access Control", function () {
    it("Should only allow owner to add markets", async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const newToken = await MockERC20.deploy("New Token", "NEW", 18);
      
      await expect(
        lendingProtocol.connect(alice).addMarket(newToken.address, 1000)
      ).to.be.revertedWith("Ownable: caller is not the owner");
    });
  });

  describe("Edge Cases", function () {
    it("Should handle zero amounts correctly", async function () {
      await expect(
        lendingProtocol.connect(alice).supply(usdc.address, 0)
      ).to.be.revertedWith("Amount must be greater than 0");

      await expect(
        lendingProtocol.connect(alice).borrow(usdc.address, 0)
      ).to.be.revertedWith("Amount must be greater than 0");

      await expect(
        lendingProtocol.connect(alice).redeem(usdc.address, 0)
      ).to.be.revertedWith("Amount must be greater than 0");

      await expect(
        lendingProtocol.connect(alice).repay(usdc.address, 0)
      ).to.be.revertedWith("Amount must be greater than 0");
    });

    it("Should handle inactive markets correctly", async function () {
      const MockERC20 = await ethers.getContractFactory("MockERC20");
      const inactiveToken = await MockERC20.deploy("Inactive", "INACTIVE", 18);
      
      await expect(
        lendingProtocol.connect(alice).supply(inactiveToken.address, 1000)
      ).to.be.revertedWith("Market not active");
    });
  });

  describe("Gas Optimization", function () {
    it("Should not accrue interest unnecessarily", async function () {
      // Supply tokens
      const supplyAmount = ethers.utils.parseUnits("1000", USDC_DECIMALS);
      await usdc.connect(alice).approve(lendingProtocol.address, supplyAmount);
      await lendingProtocol.connect(alice).supply(usdc.address, supplyAmount);

      const market1 = await lendingProtocol.markets(usdc.address);
      
      // Call accrueInterest immediately again
      await lendingProtocol.accrueInterest(usdc.address);
      
      const market2 = await lendingProtocol.markets(usdc.address);
      
      // Indices should be the same since no time passed
      expect(market1.supplyIndex).to.equal(market2.supplyIndex);
      expect(market1.borrowIndex).to.equal(market
