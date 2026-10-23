// Test environment defaults
process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://localhost:27017/stellarproof-test';
process.env.STELLAR_RPC_URL = process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org';
process.env.STELLAR_NETWORK_PASSPHRASE = process.env.STELLAR_NETWORK_PASSPHRASE || 'Test SDF Network ; September 2015';
process.env.ORACLE_CONTRACT_ID = process.env.ORACLE_CONTRACT_ID || 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
process.env.PROVENANCE_CONTRACT_ID = process.env.PROVENANCE_CONTRACT_ID || 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
process.env.REGISTRY_CONTRACT_ID = process.env.REGISTRY_CONTRACT_ID || 'CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM';
process.env.ORACLE_SECRET_KEY = process.env.ORACLE_SECRET_KEY || 'SD5PTCKHRCXXW34FB2TOUJDFMYLOH4KMPDJ25VJKY4KE2UH6QGWKPLG2';
process.env.BASE_FEE = process.env.BASE_FEE || '100';
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-with-at-least-32-chars-long';
process.env.PINATA_JWT = process.env.PINATA_JWT || 'test-pinata-jwt';
process.env.PINATA_GATEWAY_URL = process.env.PINATA_GATEWAY_URL || 'https://gateway.pinata.cloud/ipfs';
process.env.CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || 'test';
process.env.CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || 'test';
process.env.CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'test';
process.env.MASTER_KEY = process.env.MASTER_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.KMS_MASTER_KEY = process.env.KMS_MASTER_KEY || '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

export {};
