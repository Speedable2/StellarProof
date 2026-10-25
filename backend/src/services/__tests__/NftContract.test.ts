import { Keypair, nativeToScVal, StrKey } from '@stellar/stellar-sdk';
import { NftContractReader } from '../contracts/NftContract';
import type { ContractQueryClient } from '../contracts/ContractReader';

describe('NftContractReader', () => {
  const contractId = StrKey.encodeContract(Buffer.alloc(32, 3));
  const holder = Keypair.random().publicKey();

  it.each([[0n, false], [1n, true], [12345678901234567890n, true]] as const)(
    'returns a typed result for balance %s', async (balance, holdsToken) => {
      const invoke = jest.fn().mockResolvedValue(nativeToScVal(balance, { type: 'i128' }));
      const reader = new NftContractReader('balance', { invoke } as unknown as ContractQueryClient);

      await expect(reader.getOwnership(contractId, holder)).resolves.toEqual({
        balance: balance.toString(),
        holdsToken,
      });
      expect(invoke).toHaveBeenCalledWith(expect.objectContaining({ contractId, method: 'balance' }));
    }
  );

  it('rejects invalid contract and wallet addresses before the RPC call', async () => {
    const invoke = jest.fn();
    const reader = new NftContractReader('balance', { invoke } as unknown as ContractQueryClient);
    await expect(reader.getOwnership('not-a-contract', holder)).rejects.toMatchObject({ code: 'ACCESS_POLICY_INVALID' });
    await expect(reader.getOwnership(contractId, 'not-a-wallet')).rejects.toMatchObject({ code: 'INVALID_STELLAR_ADDRESS' });
    expect(invoke).not.toHaveBeenCalled();
  });
});
