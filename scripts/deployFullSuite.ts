import { BigNumber, Contract, Signer, Wallet } from 'ethers';
import { ethers } from 'hardhat';
import OnchainID from '@onchain-id/solidity';

type DeploymentResult = {
  accounts: {
    deployer: string;
    tokenIssuer: string;
    tokenAgent: string;
    tokenAdmin: string;
    claimIssuer: string;
    claimIssuerSigningKey: string;
    aliceActionKey: string;
    aliceWallet: string;
    bobWallet: string;
    charlieWallet: string;
    davidWallet: string;
    anotherWallet: string;
  };
  identities: {
    aliceIdentity: string;
    bobIdentity: string;
    charlieIdentity: string;
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

async function deployFullSuite(): Promise<DeploymentResult> {
  const [deployer, tokenIssuer, tokenAgent, tokenAdmin, claimIssuer, aliceWallet, bobWallet, charlieWallet, davidWallet, anotherWallet] =
    await ethers.getSigners();

  const claimIssuerSigningKey = Wallet.createRandom();
  const aliceActionKey = Wallet.createRandom();

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

  const aliceIdentity = await deployIdentityProxy(identityImplementationAuthority.address, aliceWallet.address, deployer);
  await aliceIdentity
    .connect(aliceWallet)
    .addKey(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(['address'], [aliceActionKey.address]),
      ),
      2,
      1,
    );

  const bobIdentity = await deployIdentityProxy(identityImplementationAuthority.address, bobWallet.address, deployer);
  const charlieIdentity = await deployIdentityProxy(identityImplementationAuthority.address, charlieWallet.address, deployer);

  await identityRegistry.connect(deployer).addAgent(tokenAgent.address);
  await identityRegistry.connect(deployer).addAgent(token.address);

  await identityRegistry
    .connect(tokenAgent)
    .batchRegisterIdentity(
      [aliceWallet.address, bobWallet.address],
      [aliceIdentity.address, bobIdentity.address],
      [42, 666],
    );

  const claimForAlice = {
    data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Some claim public data.')),
    issuer: claimIssuerContract.address,
    topic: claimTopics[0],
    scheme: 1,
    identity: aliceIdentity.address,
    signature: '',
  };
  claimForAlice.signature = await claimIssuerSigningKey.signMessage(
    ethers.utils.arrayify(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['address', 'uint256', 'bytes'],
          [claimForAlice.identity, claimForAlice.topic, claimForAlice.data],
        ),
      ),
    ),
  );

  await aliceIdentity
    .connect(aliceWallet)
    .addClaim(
      claimForAlice.topic,
      claimForAlice.scheme,
      claimForAlice.issuer,
      claimForAlice.signature,
      claimForAlice.data,
      '',
    );

  const claimForBob = {
    data: ethers.utils.hexlify(ethers.utils.toUtf8Bytes('Some claim public data.')),
    issuer: claimIssuerContract.address,
    topic: claimTopics[0],
    scheme: 1,
    identity: bobIdentity.address,
    signature: '',
  };
  claimForBob.signature = await claimIssuerSigningKey.signMessage(
    ethers.utils.arrayify(
      ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ['address', 'uint256', 'bytes'],
          [claimForBob.identity, claimForBob.topic, claimForBob.data],
        ),
      ),
    ),
  );

  await bobIdentity
    .connect(bobWallet)
    .addClaim(
      claimForBob.topic,
      claimForBob.scheme,
      claimForBob.issuer,
      claimForBob.signature,
      claimForBob.data,
      '',
    );

  const aliceMintAmount = BigNumber.from(process.env.TREX_MINT_ALICE ?? '1000');
  const bobMintAmount = BigNumber.from(process.env.TREX_MINT_BOB ?? '500');

  await token.connect(tokenAgent).mint(aliceWallet.address, aliceMintAmount);
  await token.connect(tokenAgent).mint(bobWallet.address, bobMintAmount);

  await agentManager.connect(tokenAgent).addAgentAdmin(tokenAdmin.address);
  await token.connect(deployer).addAgent(agentManager.address);
  await identityRegistry.connect(deployer).addAgent(agentManager.address);

  await token.connect(tokenAgent).unpause();

  return {
    accounts: {
      deployer: deployer.address,
      tokenIssuer: tokenIssuer.address,
      tokenAgent: tokenAgent.address,
      tokenAdmin: tokenAdmin.address,
      claimIssuer: claimIssuer.address,
      claimIssuerSigningKey: claimIssuerSigningKey.address,
      aliceActionKey: aliceActionKey.address,
      aliceWallet: aliceWallet.address,
      bobWallet: bobWallet.address,
      charlieWallet: charlieWallet.address,
      davidWallet: davidWallet.address,
      anotherWallet: anotherWallet.address,
    },
    identities: {
      aliceIdentity: aliceIdentity.address,
      bobIdentity: bobIdentity.address,
      charlieIdentity: charlieIdentity.address,
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

function logDeployment(result: DeploymentResult) {
  console.log('\n--- Accounts ---');
  console.table(result.accounts);

  console.log('\n--- Identities ---');
  console.table(result.identities);

  console.log('\n--- Core Suite ---');
  console.table(result.suite);

  console.log('\n--- Authorities ---');
  console.table(result.authorities);

  console.log('\n--- Factories ---');
  console.table(result.factories);
}

async function main() {
  console.log('Starting full TREX suite deployment...');
  const result = await deployFullSuite();
  console.log('TREX suite deployed successfully!');
  logDeployment(result);
}

main().catch((error) => {
  console.error('Deployment failed:', error);
  process.exitCode = 1;
});
