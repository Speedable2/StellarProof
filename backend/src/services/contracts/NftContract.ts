import { Keypair, scValToNative, StrKey } from '@stellar/stellar-sdk';
import { StatusCodes } from 'http-status-codes';
import { AppError } from '../../errors/AppError';
import type { NFTOwnershipResult } from '../../types/spv.types';
import { toAddressScVal } from '../../utils/xdr';
import { SorobanContractQueryClient, type ContractQueryClient } from './ContractReader';

export class NftContractReader {
  constructor(
    private readonly balanceFunction: string,
    private readonly client: ContractQueryClient
  ) {
    if (!balanceFunction.trim()) throw new Error('NFT balance function must be configured');
  }

  async getOwnership(contractId: string, holderPublicKey: string): Promise<NFTOwnershipResult> {
    if (!StrKey.isValidContract(contractId)) {
      throw new AppError('SPV record has an invalid NFT contract address', StatusCodes.INTERNAL_SERVER_ERROR, 'ACCESS_POLICY_INVALID');
    }
    if (!StrKey.isValidEd25519PublicKey(holderPublicKey)) {
      throw new AppError('Invalid Stellar wallet address', StatusCodes.BAD_REQUEST, 'INVALID_STELLAR_ADDRESS');
    }
    const result = await this.client.invoke({
      contractId,
      method: this.balanceFunction,
      args: [toAddressScVal(holderPublicKey, 'holderPublicKey')],
    });
    const value: unknown = scValToNative(result);
    let balance: bigint;
    if (typeof value === 'bigint') balance = value;
    else if (typeof value === 'number' && Number.isSafeInteger(value)) balance = BigInt(value);
    else if (typeof value === 'string' && /^\d+$/.test(value)) balance = BigInt(value);
    else throw new AppError('NFT balance function returned a non-integer value', StatusCodes.BAD_GATEWAY, 'NFT_BALANCE_INVALID');
    if (balance < BigInt(0)) throw new AppError('NFT balance function returned a negative balance', StatusCodes.BAD_GATEWAY, 'NFT_BALANCE_INVALID');
    return { holdsToken: balance > BigInt(0), balance: balance.toString() };
  }
}

export async function queryNftOwnership(contractId: string, holderPublicKey: string): Promise<NFTOwnershipResult> {
  const { env } = require('../../config/env') as typeof import('../../config/env');
  if (!StrKey.isValidEd25519SecretSeed(env.STELLAR_ORACLE_SECRET_KEY)) {
    throw new AppError('STELLAR_ORACLE_SECRET_KEY must be a valid Stellar secret seed', StatusCodes.INTERNAL_SERVER_ERROR, 'NFT_CHECK_UNAVAILABLE');
  }
  const sourceAccount = Keypair.fromSecret(env.STELLAR_ORACLE_SECRET_KEY).publicKey();
  const reader = new NftContractReader(
    env.STELLAR_NFT_BALANCE_FN,
    new SorobanContractQueryClient(sourceAccount)
  );
  return reader.getOwnership(contractId, holderPublicKey);
}
