// scripts/registerIdentity.ts
import { ethers } from "hardhat";

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
    '  USER_WALLET=<address> npx hardhat run scripts/registerIdentity.ts --network <network>\n' +
    '  or add USER_WALLET=<address> to your .env file'
  );
}

async function main() {
  // --- Configuration ---
  const IDENTITY_REGISTRY_ADDRESS = process.env.IDENTITY_REGISTRY_ADDRESS ?? "0x51991f45EA1475C4C0eD37a9f615041a3b0bCc6C";
  const agentPrivateKey = process.env.AGENT_PRIVATE_KEY ?? process.env.PRIVATE_KEY;
  if (!agentPrivateKey) {
    throw new Error('Missing AGENT_PRIVATE_KEY (preferred) or PRIVATE_KEY in environment.');
  }
  const USER_WALLET = parseUserWallet();
  const USER_IDENTITY_ADDRESS = process.env.USER_IDENTITY_ADDRESS;
  if (!USER_IDENTITY_ADDRESS) {
    throw new Error('Missing USER_IDENTITY_ADDRESS in environment. Provide the new Identity Contract Address from the first script.');
  }

  // --- Script ---
  if (!ethers.utils.isAddress(USER_IDENTITY_ADDRESS)) {
    throw new Error("Please paste the new Identity Contract Address from the first script.");
  }

  const provider = ethers.provider;
  const agent = new ethers.Wallet(agentPrivateKey, provider);
  
  // Define minimal ABI and get contract instance
  const identityRegistryAbi = ["function batchRegisterIdentity(address[], address[], uint16[]) external"];
  const identityRegistry = await ethers.getContractAt(identityRegistryAbi, IDENTITY_REGISTRY_ADDRESS);

  console.log(`Registering identity for user: ${USER_WALLET}`);
  console.log(`   OnchainID: ${USER_IDENTITY_ADDRESS}`);

  const tx = await identityRegistry
    .connect(agent)
    .batchRegisterIdentity([USER_WALLET], [USER_IDENTITY_ADDRESS], [42]);

  await tx.wait();
  console.log(`Transaction successful: ${tx.hash}`);
  console.log("✅ User has been successfully registered and whitelisted!");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});