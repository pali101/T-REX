import { BigNumber, Contract, Signer, Wallet, providers } from 'ethers';
import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';

type InfrastructureDeploymentResult = {
  accounts: {
    deployer: string;
    tokenIssuer: string;
    tokenAgent: string;
    tokenAdmin: string;
    claimIssuer: string;
    claimIssuerSigningKey: string;
  };
  suite: {
    claimIssuerContract: string;
    claimTopicsRegistry: string;
    trustedIssuersRegistry: string;
    identityRegistryStorage: string;
    defaultCompliance: string;
    identityRegistry: string;
    tokenOID: string;
    token: string;
    agentManager: string;
  };
  authorities: {
    trexImplementationAuthority: string;
    identityImplementationAuthority: string;
  };
  factories: {
    trexFactory: string;
    identityFactory: string;
  };
};

async function deployIdentityProxy(
  implementationAuthority: Contract['address'],
  managementKey: string,
  signer: Signer,
) {
  const identity = await ethers.deployContract(
    'IdentityProxy',
    [implementationAuthority, managementKey],
    signer
  );

  await identity.deployed();
  return ethers.getContractAt('Identity', identity.address, signer);
}

async function deployIdentityImplementationAuthority(signer: Signer) {
  const identityImplementation = await new ethers.ContractFactory(
    OnchainID.contracts.Identity.abi,
    OnchainID.contracts.Identity.bytecode,
    signer,
  ).deploy(await signer.getAddress(), true);
  await identityImplementation.deployed();

  const identityImplementationAuthority = await new ethers.ContractFactory(
    OnchainID.contracts.ImplementationAuthority.abi,
    OnchainID.contracts.ImplementationAuthority.bytecode,
    signer,
  ).deploy(identityImplementation.address);
  await identityImplementationAuthority.deployed();

  const identityFactory = await new ethers.ContractFactory(
    OnchainID.contracts.Factory.abi,
    OnchainID.contracts.Factory.bytecode,
    signer,
  ).deploy(identityImplementationAuthority.address);
  await identityFactory.deployed();

  return {
    identityImplementation,
    identityImplementationAuthority,
    identityFactory,
  };
}

async function deployTREXImplementationAuthority(signer: Signer, contracts: Record<string, string>) {
  const trexImplementationAuthority = await ethers.deployContract(
    'TREXImplementationAuthority',
    [true, ethers.constants.AddressZero, ethers.constants.AddressZero],
    signer,
  );

  const versionStruct = {
    major: 4,
    minor: 0,
    patch: 0,
  };

  await trexImplementationAuthority
    .connect(signer)
    .addAndUseTREXVersion(versionStruct, {
      tokenImplementation: contracts.token,
      ctrImplementation: contracts.claimTopicsRegistry,
      irImplementation: contracts.identityRegistry,
      irsImplementation: contracts.identityRegistryStorage,
      tirImplementation: contracts.trustedIssuersRegistry,
      mcImplementation: contracts.modularCompliance,
    });

  return trexImplementationAuthority;
}

type RoleKey = 'tokenIssuer' | 'tokenAgent' | 'tokenAdmin' | 'claimIssuer';

async function resolveRoleSigner(
  role: RoleKey,
  availableSigner: Signer | undefined,
  provider: providers.Provider,
  deployer: Signer,
): Promise<Signer> {
  const envKeyName = `TREX_${role.toUpperCase()}_PRIVATE_KEY` as const;
  const envKeyValue = process.env[envKeyName];

  if (envKeyValue) {
    return new Wallet(envKeyValue, provider);
  }

  if (availableSigner) {
    return availableSigner;
  }

  const deployerAddress = await deployer.getAddress();

  console.warn(
    `⚠️  No dedicated signer configured for ${role}. Falling back to deployer account (${deployerAddress}).`,
  );
  return deployer;
}

async function deployTREXSuiteInfrastructure(): Promise<InfrastructureDeploymentResult> {
  const availableSigners = await ethers.getSigners();

  if (availableSigners.length === 0) {
    throw new Error('No signer available in the current Hardhat network configuration.');
  }

  const deployer = availableSigners[0];
  const provider = deployer.provider ?? ethers.provider;

  if (!provider) {
    throw new Error('Unable to resolve a provider from the deployer signer.');
  }

  const tokenIssuer = await resolveRoleSigner('tokenIssuer', availableSigners[1], provider, deployer);
  const tokenAgent = await resolveRoleSigner('tokenAgent', availableSigners[2], provider, deployer);
  const tokenAdmin = await resolveRoleSigner('tokenAdmin', availableSigners[3], provider, deployer);
  const claimIssuer = await resolveRoleSigner('claimIssuer', availableSigners[4], provider, deployer);

  const deployerAddress = await deployer.getAddress();
  const tokenIssuerAddress = await tokenIssuer.getAddress();
  const tokenAgentAddress = await tokenAgent.getAddress();
  const tokenAdminAddress = await tokenAdmin.getAddress();
  const claimIssuerAddress = await claimIssuer.getAddress();

  const claimIssuerSigningKey = process.env.TREX_CLAIM_ISSUER_SIGNING_KEY_PRIVATE_KEY
    ? new Wallet(process.env.TREX_CLAIM_ISSUER_SIGNING_KEY_PRIVATE_KEY)
    : Wallet.createRandom();

  const claimTopicsRegistryImplementation = await ethers.deployContract('ClaimTopicsRegistry', deployer);
  const trustedIssuersRegistryImplementation = await ethers.deployContract('TrustedIssuersRegistry', deployer);
  const identityRegistryStorageImplementation = await ethers.deployContract('IdentityRegistryStorage', deployer);
  const identityRegistryImplementation = await ethers.deployContract('IdentityRegistry', deployer);
  const modularComplianceImplementation = await ethers.deployContract('ModularCompliance', deployer);
  const tokenImplementation = await ethers.deployContract('Token', deployer);

  const { identityImplementation, identityImplementationAuthority, identityFactory } = await deployIdentityImplementationAuthority(deployer);

  const trexImplementationAuthority = await deployTREXImplementationAuthority(deployer, {
    token: tokenImplementation.address,
    claimTopicsRegistry: claimTopicsRegistryImplementation.address,
    identityRegistry: identityRegistryImplementation.address,
    identityRegistryStorage: identityRegistryStorageImplementation.address,
    trustedIssuersRegistry: trustedIssuersRegistryImplementation.address,
    modularCompliance: modularComplianceImplementation.address,
  });

  const trexFactory = await ethers.deployContract(
    'TREXFactory',
    [trexImplementationAuthority.address, identityFactory.address],
    deployer,
  );
  await identityFactory.connect(deployer).addTokenFactory(trexFactory.address);

  const claimTopicsRegistryProxy = await ethers.deployContract(
    'ClaimTopicsRegistryProxy',
    [trexImplementationAuthority.address],
    deployer
  );
  await claimTopicsRegistryProxy.deployed();
  const claimTopicsRegistry = await ethers.getContractAt('ClaimTopicsRegistry', claimTopicsRegistryProxy.address);
  console.log(`✅ ClaimTopicsRegistry deployed to: ${claimTopicsRegistry.address}`);

  const trustedIssuersRegistryProxy = await ethers.deployContract(
    'TrustedIssuersRegistryProxy',
    [trexImplementationAuthority.address],
    deployer
  );
  await trustedIssuersRegistryProxy.deployed();
  const trustedIssuersRegistry = await ethers.getContractAt('TrustedIssuersRegistry', trustedIssuersRegistryProxy.address);

  console.log(`✅ TrustedIssuersRegistry deployed to: ${trustedIssuersRegistry.address}`);

  const identityRegistryStorageProxy = await ethers.deployContract(
    'IdentityRegistryStorageProxy',
    [trexImplementationAuthority.address],
    deployer
  );
  await identityRegistryStorageProxy.deployed();
  const identityRegistryStorage = await ethers.getContractAt('IdentityRegistryStorage', identityRegistryStorageProxy.address);
  console.log(`✅ IdentityRegistryStorage deployed to: ${identityRegistryStorage.address}`);

  const defaultCompliance = await ethers.deployContract('DefaultCompliance', deployer);
  await defaultCompliance.deployed();
  console.log(`✅ DefaultCompliance deployed to: ${defaultCompliance.address}`);

  const identityRegistryProxy = await ethers
    .deployContract(
      'IdentityRegistryProxy',
      [
        trexImplementationAuthority.address,
        trustedIssuersRegistry.address,
        claimTopicsRegistry.address,
        identityRegistryStorage.address,
      ],
      deployer,
    );
  await identityRegistryProxy.deployed();
  const identityRegistry = await ethers.getContractAt('IdentityRegistry', identityRegistryProxy.address);
  console.log(`✅ IdentityRegistry deployed to: ${identityRegistry.address}`);

  const tokenOID = await deployIdentityProxy(
    identityImplementationAuthority.address,
    tokenIssuerAddress,
    deployer,
  );
  console.log(`✅ Token OnchainID deployed to: ${tokenOID.address}`);

  const tokenName = process.env.TREX_TOKEN_NAME ?? 'TREXDINO';
  const tokenSymbol = process.env.TREX_TOKEN_SYMBOL ?? 'TREX';
  const tokenDecimals = BigNumber.from(process.env.TREX_TOKEN_DECIMALS ?? '0');

  const tokenProxy = await ethers.deployContract(
    'TokenProxy',
    [
      trexImplementationAuthority.address,
      identityRegistry.address,
      defaultCompliance.address,
      tokenName,
      tokenSymbol,
      tokenDecimals,
      tokenOID.address,
    ],
    deployer
  );
  await tokenProxy.deployed();
  const token = await ethers.getContractAt('Token', tokenProxy.address);
  console.log(`✅ Token deployed to: ${token.address}`);

  const agentManager = await ethers.deployContract('AgentManager', [token.address], tokenAgent);
  console.log(`✅ AgentManager deployed to: ${agentManager.address}`);

  await identityRegistryStorage.connect(deployer).bindIdentityRegistry(identityRegistry.address);
  await token.connect(deployer).addAgent(tokenAgentAddress);
  await identityRegistry.connect(deployer).addAgent(tokenAgentAddress);
  await identityRegistry.connect(deployer).addAgent(token.address);


  const claimTopics = [ethers.utils.id('CLAIM_TOPIC')];
  await claimTopicsRegistry.connect(deployer).addClaimTopic(claimTopics[0]);

  const claimIssuerContract = await ethers.deployContract('ClaimIssuer', [claimIssuerAddress], claimIssuer);
  await claimIssuerContract
    .connect(claimIssuer)
    .addKey(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['address'], [claimIssuerSigningKey.address]),
      ),
      3,
      1,
    );

  await trustedIssuersRegistry.connect(deployer).addTrustedIssuer(claimIssuerContract.address, claimTopics);

  await agentManager.connect(tokenAgent).addAgentAdmin(tokenAdminAddress);
  await token.connect(deployer).addAgent(agentManager.address);
  await identityRegistry.connect(deployer).addAgent(agentManager.address);

  // NOTE: Token remains paused. Unpause it via the tokenAgent when ready to go live.
  // await token.connect(tokenAgent).unpause();

  return {
    accounts: {
      deployer: deployerAddress,
      tokenIssuer: tokenIssuerAddress,
      tokenAgent: tokenAgentAddress,
      tokenAdmin: tokenAdminAddress,
      claimIssuer: claimIssuerAddress,
      claimIssuerSigningKey: claimIssuerSigningKey.address,
    },
    suite: {
      claimIssuerContract: claimIssuerContract.address,
      claimTopicsRegistry: claimTopicsRegistry.address,
      trustedIssuersRegistry: trustedIssuersRegistry.address,
      identityRegistryStorage: identityRegistryStorage.address,
      defaultCompliance: defaultCompliance.address,
      identityRegistry: identityRegistry.address,
      tokenOID: tokenOID.address,
      token: token.address,
      agentManager: agentManager.address,
    },
    authorities: {
      trexImplementationAuthority: trexImplementationAuthority.address,
      identityImplementationAuthority: identityImplementationAuthority.address,
    },
    factories: {
      trexFactory: trexFactory.address,
      identityFactory: identityFactory.address,
    },
  };
}

function logDeployment(result: InfrastructureDeploymentResult) {
  console.log('\n--- Accounts ---');
  console.table(result.accounts);

  console.log('\n--- Core Suite ---');
  console.table(result.suite);

  console.log('\n--- Authorities ---');
  console.table(result.authorities);

  console.log('\n--- Factories ---');
  console.table(result.factories);
}

async function main() {
  console.log('Starting full TREX suite deployment...');
  const result = await deployTREXSuiteInfrastructure();
  console.log('TREX suite deployed successfully!');
  logDeployment(result);
}

main().catch((error) => {
  console.error('Deployment failed:', error);
  process.exitCode = 1;
});
