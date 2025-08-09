const { ethers, upgrades } = require("hardhat");

async function main() {
  console.log("Starting deployment...");

  const [deployer] = await ethers.getSigners();
  console.log("Deploying contracts with the account:", deployer.address);
  console.log("Account balance:", (await deployer.getBalance()).toString());

  // Deploy the main lending protocol
  const DeFiLendingProtocol = await ethers.getContractFactory("DeFiLendingProtocol");
  const lendingProtocol = await DeFiLendingProtocol.deploy();
  await lendingProtocol.deployed();

  console.log("DeFiLendingProtocol deployed to:", lendingProtocol.address);

  // Deploy mock ERC20 tokens for testing
  const MockERC20 = await ethers.getContractFactory("MockERC20");
  
  const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
  await usdc.deployed();
  console.log("USDC deployed to:", usdc.address);

  const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
  await weth.deployed();
  console.log("WETH deployed to:", weth.address);

  const wbtc = await MockERC20.deploy("Wrapped Bitcoin", "WBTC", 8);
  await wbtc.deployed();
  console.log("WBTC deployed to:", wbtc.address);

  // Add markets to the protocol
  console.log("Adding markets...");
  
  await lendingProtocol.addMarket(usdc.address, 1000); // 10% reserve factor
  console.log("USDC market added");
  
  await lendingProtocol.addMarket(weth.address, 1500); // 15% reserve factor
  console.log("WETH market added");
  
  await lendingProtocol.addMarket(wbtc.address, 2000); // 20% reserve factor
  console.log("WBTC market added");

  //
