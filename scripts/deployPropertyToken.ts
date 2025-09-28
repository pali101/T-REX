// scripts/deployPropertyToken.ts
import { ethers, network } from "hardhat";
import { Log } from "@ethersproject/abstract-provider";

type ClaimDetails = {
  claimTopics: number[];
  issuers: string[];
  issuerClaims: number[][];
};

type SuiteAddresses = {
  token: string;
  identityRegistry: string;
  identityRegistryStorage: string;
  trustedIssuersRegistry: string;
  claimTopicsRegistry: string;
  modularCompliance: string;
};

const DEFAULT_FACTORY_PLACEHOLDER = "0xB7f8BC63BbcaD18155201308C8f3540b07f84F5e";

function requireAddress(label: string, value: string): string {
  if (!ethers.utils.isAddress(value)) {
    throw new Error(`${label} must be a valid Ethereum address`);
  }
  return ethers.utils.getAddress(value);
}

async function ensureContractDeployed(address: string, label: string) {
  const code = await ethers.provider.getCode(address);
  if (code === "0x") {
    const networkName = network.name ?? "unknown";
    const hint =
      networkName === "hardhat"
        ?
            "Start `npx hardhat node` in another terminal and rerun with `--network localhost`, or deploy the factory within this script before using it."
        : `Make sure the contract is deployed on the "${networkName}" network.`;
    throw new Error(
      `${label} (${address}) has no contract bytecode on network "${networkName}". ${hint}`,
    );
  }
}

function requireSalt(input: string): string {
  const salt = input.trim();
  if (!salt) {
    throw new Error("Deployment salt cannot be empty");
  }
  return salt;
}

function parseDecimals(raw: string | undefined, fallback = 0): number {
  const source = raw ?? `${fallback}`;
  const parsed = Number(source);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 18) {
    throw new Error("Token decimals must be an integer between 0 and 18");
  }
  return parsed;
}

function buildClaimDetails(): ClaimDetails {
  return {
    claimTopics: [],
    issuers: [],
    issuerClaims: [],
  };
}

function logSuite(table: SuiteAddresses) {
  console.log("\n--- Deployed Suite ---");
  console.table({
    Token: table.token,
    IdentityRegistry: table.identityRegistry,
    IdentityRegistryStorage: table.identityRegistryStorage,
    TrustedIssuersRegistry: table.trustedIssuersRegistry,
    ClaimTopicsRegistry: table.claimTopicsRegistry,
    ModularCompliance: table.modularCompliance,
  });
}

type EventArgs = {
  length: number;
  [key: string]: unknown;
};

function normalizeAddressArg(args: EventArgs, key: string, index: number): string {
  const candidate = args[key] ?? args[index];
  const value =
    typeof candidate === "string"
      ? candidate
      : typeof candidate === "object" && candidate !== null && "toString" in candidate
      ? (candidate as { toString: () => string }).toString()
      : undefined;

  if (!value || value === "0x" || value === ethers.constants.AddressZero) {
    throw new Error(`Could not read ${key} from TREXSuiteDeployed event.`);
  }

  return ethers.utils.getAddress(value);
}

async function main() {
  console.log("Preparing single property TREX deployment...");

  const [deployer, secondarySigner] = await ethers.getSigners();

  const factoryAddressInput = process.env.TREX_FACTORY_ADDRESS ?? DEFAULT_FACTORY_PLACEHOLDER;
  const factoryAddress = requireAddress("TREX factory address", factoryAddressInput);

  const propertyTokenName = process.env.PROPERTY_TOKEN_NAME?.trim() || "Luxury Villa A4";
  const propertyTokenSymbol = process.env.PROPERTY_TOKEN_SYMBOL?.trim() || "LVA1";
  const propertyTokenDecimals = parseDecimals(process.env.PROPERTY_TOKEN_DECIMALS, 0);

  const propertyOwnerAddressInput =
    process.env.PROPERTY_OWNER_ADDRESS ?? secondarySigner?.address ?? deployer.address;
  const propertyOwnerAddress = requireAddress("Property owner address", propertyOwnerAddressInput);

  const deploymentSalt = requireSalt(process.env.PROPERTY_TOKEN_SALT ?? propertyTokenName);

  await ensureContractDeployed(factoryAddress, "TREX factory address");

  const trexFactory = await ethers.getContractAt("ITREXFactory", factoryAddress, deployer);

  let existingDeployment = ethers.constants.AddressZero;
  try {
    existingDeployment = await trexFactory.getToken(deploymentSalt);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `⚠️  Skipping duplicate deployment check because factory.getToken reverted: ${message}. ` +
        "Continuing with deployment.",
    );
  }
  if (existingDeployment && existingDeployment !== ethers.constants.AddressZero) {
    console.log(
      `⚠️  Detected existing TREX suite for salt "${deploymentSalt}": ${existingDeployment}. ` +
        "Aborting to avoid duplicate deployment.",
    );
    return;
  }

  const uniqueAgents = Array.from(new Set([deployer.address, propertyOwnerAddress]));

  const tokenDetails = {
    owner: propertyOwnerAddress,
    name: propertyTokenName,
    symbol: propertyTokenSymbol,
    decimals: propertyTokenDecimals,
    irs: ethers.constants.AddressZero,
    ONCHAINID: ethers.constants.AddressZero,
    irAgents: uniqueAgents,
    tokenAgents: uniqueAgents,
    complianceModules: [] as string[],
    complianceSettings: [] as string[],
  };

  const claimDetails = buildClaimDetails();

  console.log(`Using TREX factory at: ${factoryAddress}`);
  console.log(`Deployment salt: ${deploymentSalt}`);
  console.log(`Deployer: ${deployer.address}`);
  console.log(`Property owner: ${propertyOwnerAddress}`);
  console.log(`Deploying token ${propertyTokenName} (${propertyTokenSymbol}) with ${propertyTokenDecimals} decimals`);

  const tx = await trexFactory.deployTREXSuite(deploymentSalt, tokenDetails, claimDetails);
  console.log(`Submitted deployment tx: ${tx.hash}`);

  const receipt = await tx.wait();
  console.log(`Transaction confirmed in block ${receipt.blockNumber} (gas used: ${receipt.gasUsed.toString()})`);

  let suiteAddresses: SuiteAddresses | undefined;

  for (const log of receipt.logs as Log[]) {
    try {
      const parsedLog = trexFactory.interface.parseLog(log);
      if (parsedLog.name === "TREXSuiteDeployed") {
        const args = parsedLog.args as unknown as EventArgs;
        suiteAddresses = {
          token: normalizeAddressArg(args, "_token", 0),
          identityRegistry: normalizeAddressArg(args, "_ir", 1),
          identityRegistryStorage: normalizeAddressArg(args, "_irs", 2),
          trustedIssuersRegistry: normalizeAddressArg(args, "_tir", 3),
          claimTopicsRegistry: normalizeAddressArg(args, "_ctr", 4),
          modularCompliance: normalizeAddressArg(args, "_mc", 5),
        };
        break;
      }
    } catch (error) {
      // ignore logs that do not belong to the TREX factory
    }
  }

  if (!suiteAddresses) {
    throw new Error("Could not find TREXSuiteDeployed event in the transaction receipt.");
  }

  console.log("✅ New property TREX suite deployed successfully!");
  logSuite(suiteAddresses);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});