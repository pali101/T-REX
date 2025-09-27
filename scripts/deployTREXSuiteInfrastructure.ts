import { BigNumber, Contract, Signer, Wallet } from 'ethers';
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
  const factory = new ethers.ContractFactory(
    OnchainID.contracts.IdentityProxy.abi,
    OnchainID.contracts.IdentityProxy.bytecode,
    signer,
  );
  const identity = await factory.deploy(implementationAuthority, managementKey);
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

async function deployTREXSuiteInfrastructure(): Promise<InfrastructureDeploymentResult> {
  const [deployer, tokenIssuer, tokenAgent, tokenAdmin, claimIssuer] =
    await ethers.getSigners();

  const claimIssuerSigningKey = Wallet.createRandom();

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

  const claimTopicsRegistry = await ethers
    .deployContract('ClaimTopicsRegistryProxy', [trexImplementationAuthority.address], deployer)
    .then(async (proxy) => ethers.getContractAt('ClaimTopicsRegistry', proxy.address));

  const trustedIssuersRegistry = await ethers
    .deployContract('TrustedIssuersRegistryProxy', [trexImplementationAuthority.address], deployer)
    .then(async (proxy) => ethers.getContractAt('TrustedIssuersRegistry', proxy.address));

  const identityRegistryStorage = await ethers
    .deployContract('IdentityRegistryStorageProxy', [trexImplementationAuthority.address], deployer)
    .then(async (proxy) => ethers.getContractAt('IdentityRegistryStorage', proxy.address));

  const defaultCompliance = await ethers.deployContract('DefaultCompliance', deployer);

  const identityRegistry = await ethers
    .deployContract(
      'IdentityRegistryProxy',
      [
        trexImplementationAuthority.address,
        trustedIssuersRegistry.address,
        claimTopicsRegistry.address,
        identityRegistryStorage.address,
      ],
      deployer,
    )
    .then(async (proxy) => ethers.getContractAt('IdentityRegistry', proxy.address));

  const tokenOID = await deployIdentityProxy(
    identityImplementationAuthority.address,
    tokenIssuer.address,
    deployer,
  );

  const tokenName = process.env.TREX_TOKEN_NAME ?? 'TREXDINO';
  const tokenSymbol = process.env.TREX_TOKEN_SYMBOL ?? 'TREX';
  const tokenDecimals = BigNumber.from(process.env.TREX_TOKEN_DECIMALS ?? '0');

  const token = await ethers
    .deployContract(
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
      deployer,
    )
    .then(async (proxy) => ethers.getContractAt('Token', proxy.address));

  const agentManager = await ethers.deployContract('AgentManager', [token.address], tokenAgent);

  await identityRegistryStorage.connect(deployer).bindIdentityRegistry(identityRegistry.address);
  await token.connect(deployer).addAgent(tokenAgent.address);
  await identityRegistry.connect(deployer).addAgent(tokenAgent.address);
  await identityRegistry.connect(deployer).addAgent(token.address);


  const claimTopics = [ethers.utils.id('CLAIM_TOPIC')];
  await claimTopicsRegistry.connect(deployer).addClaimTopic(claimTopics[0]);

  const claimIssuerContract = await ethers.deployContract('ClaimIssuer', [claimIssuer.address], claimIssuer);
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

  await agentManager.connect(tokenAgent).addAgentAdmin(tokenAdmin.address);
  await token.connect(deployer).addAgent(agentManager.address);
  await identityRegistry.connect(deployer).addAgent(agentManager.address);

  // NOTE: Token remains paused. Unpause it via the tokenAgent when ready to go live.
  // await token.connect(tokenAgent).unpause();

  return {
    accounts: {
      deployer: deployer.address,
      tokenIssuer: tokenIssuer.address,
      tokenAgent: tokenAgent.address,
      tokenAdmin: tokenAdmin.address,
      claimIssuer: claimIssuer.address,
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
