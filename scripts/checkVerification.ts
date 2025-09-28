// scripts/checkVerification.ts
import { ethers } from "hardhat";

async function main() {
    // --- Configuration ---
    const identityRegistryAddress = "0x51991f45EA1475C4C0eD37a9f615041a3b0bCc6C";
    const userWalletAddress = process.env.USER_WALLET; // Your wallet address
    const agentPrivateKey = process.env.PRIVATE_KEY;

    if (!userWalletAddress || !agentPrivateKey) {
        throw new Error("Missing USER_WALLET or PRIVATE_KEY in environment.");
    }
    
    // --- Script ---
    const provider = ethers.provider;
    const agentWallet = new ethers.Wallet(agentPrivateKey, provider);

    console.log(`Checking verification status for: ${userWalletAddress}`);
    console.log(`Using Identity Registry: ${identityRegistryAddress}`);

    const identityRegistryAbi = [
        "function isVerified(address _userAddress) external view returns (bool)"
    ];

    const registryContract = new ethers.Contract(identityRegistryAddress, identityRegistryAbi, agentWallet);

    try {
        console.log("\nQuerying isVerified()...");
        const isVerified = await registryContract.isVerified(userWalletAddress);

        console.log(`\n✅ Verification check returned: ${isVerified}`);
        
        if (isVerified) {
            console.log("Identity is verified. Minting should now succeed.");
        } else {
            console.error("❌ Identity is NOT verified. This confirms the root cause of the minting failure. The issue lies within the on-chain compliance logic, likely a misconfigured Claim Issuer.");
        }

    } catch (error: any) {
        console.error(`❌ The isVerified() call failed with an error: ${error.message}`);
        console.error("This indicates a problem within the IdentityRegistry's verification logic itself.");
        process.exit(1);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });