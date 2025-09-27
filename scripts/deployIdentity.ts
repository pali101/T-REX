// scripts/deployIdentity.ts
import { ethers } from "hardhat";
import OnchainID from '@onchain-id/solidity';

function requireAddress(label: string, value: string): string {
  if (!ethers.utils.isAddress(value)) {
    throw new Error(`${label} must be a valid Ethereum address`);
  }
  return ethers.utils.getAddress(value);
}

function parseUserWallet(): string {
  // Priority: 1. Environment variable USER_WALLET, 2. Error with instructions
  const envWallet = process.env.USER_WALLET;
  
  if (envWallet) {
    return requireAddress("User wallet address (from USER_WALLET env)", envWallet);
  }
  
  throw new Error(
    'User wallet address is required. Provide it as an environment variable:\n' +
    '  USER_WALLET=0x14dC79964da2C08b23698B3D3cc7Ca32193d9955 npx hardhat run scripts/deployIdentity.ts --network <network>\n' +
    '  or add USER_WALLET=0x14dC79964da2C08b23698B3D3cc7Ca32193d9955 to your .env file'
  );
}

async function main() {
  // --- Configuration ---
  const IDENTITY_IMPLEMENTATION_AUTHORITY = process.env.IDENTITY_IMPLEMENTATION_AUTHORITY ?? "0xd436Ac872F300c2b163D2d8ecBB1498AbEEe1DdC"; // fallback to Arbitrum Sepolia identity implementation authority
  const agentPrivateKey = process.env.AGENT_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!agentPrivateKey) {
    throw new Error('Missing AGENT_PRIVATE_KEY (preferred) or PRIVATE_KEY in environment.');
  }
  const NEW_USER_WALLET = parseUserWallet();

  // --- Script ---
  const provider = ethers.provider;
  const agent = new ethers.Wallet(agentPrivateKey, provider);

  console.log(`Deploying a new OnchainID for user: ${NEW_USER_WALLET}...`);

  // Deploy the IdentityProxy contract directly
  const identityProxyFactory = new ethers.ContractFactory(
    OnchainID.contracts.IdentityProxy.abi,
    OnchainID.contracts.IdentityProxy.bytecode,
    agent
  );

  const identity = await identityProxyFactory.deploy(
    IDENTITY_IMPLEMENTATION_AUTHORITY,
    NEW_USER_WALLET // Set the user as the management key
  );
  await identity.deployed();

  const newUserIdentityAddress = identity.address;

  console.log("✅ New OnchainID deployed successfully!");
  console.log(`   User Wallet: ${NEW_USER_WALLET}`);
  console.log(`   New Identity Contract Address: ${newUserIdentityAddress}`);
  console.log("\nCopy the new identity address for the next script.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});