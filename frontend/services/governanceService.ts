import * as StellarSDK from '@stellar/stellar-sdk';
import { signTransaction } from '@stellar/freighter-api';
import { walletService } from './wallet';

export type ProposalStatus = "active" | "passed" | "rejected" | "pending";

export interface Proposal {
  id: string;
  title: string;
  summary: string;
  description: string;
  status: ProposalStatus;
  createdAt: string;
  votingEndsAt: string;
  votesFor: number;
  votesAgainst: number;
  proposer: string;
}

export type VoteChoice = "for" | "against" | "abstain";

export interface VoteResult {
  proposalId: string;
  choice: VoteChoice;
  transactionHash: string;
  castAt: string;
}

const MOCK_PROPOSALS: Proposal[] = [
  {
    id: "prop-1",
    title: "Approve new TEE attestation hash v2.4.0",
    summary: "Whitelist the upgraded TEE enclave measurement hash for oracle attestations.",
    description:
      "This proposal approves the new TEE code measurement hash (v2.4.0) produced after the latest enclave security patch. Once approved, the registry contract will accept attestations signed against this measurement.",
    status: "active",
    createdAt: "2026-09-20T10:00:00Z",
    votingEndsAt: "2026-10-27T10:00:00Z",
    votesFor: 184250,
    votesAgainst: 32110,
    proposer: "GPROPOSER1AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
  },
  {
    id: "prop-2",
    title: "Onboard Quorum Oracle as authorized provider",
    summary: "Grant authorized-provider status to Quorum Oracle on Testnet.",
    description:
      "Quorum Oracle has completed the provider verification checklist and requests authorization to submit attestations on Testnet. This proposal grants that authorization pending community vote.",
    status: "active",
    createdAt: "2026-10-05T14:30:00Z",
    votingEndsAt: "2026-10-30T14:30:00Z",
    votesFor: 54200,
    votesAgainst: 12800,
    proposer: "GPROPOSER2BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBWHF",
  },
  {
    id: "prop-3",
    title: "Revoke StellarProof TEE v1.0.0 hash",
    summary: "Deprecate the original TEE hash following end-of-support.",
    description:
      "StellarProof TEE v1.0.0 has reached end-of-support. This proposal removes the hash from the trusted registry so that no further attestations may be verified against it.",
    status: "passed",
    createdAt: "2026-08-01T09:00:00Z",
    votingEndsAt: "2026-08-08T09:00:00Z",
    votesFor: 210300,
    votesAgainst: 8900,
    proposer: "GPROPOSER3CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCWHF",
  },
  {
    id: "prop-4",
    title: "Increase minimum provider stake requirement",
    summary: "Raise the minimum XLM stake required to register as an oracle provider.",
    description:
      "To improve provider accountability, this proposal raises the minimum stake required to register as an oracle provider from 1,000 XLM to 5,000 XLM.",
    status: "rejected",
    createdAt: "2026-07-10T12:00:00Z",
    votingEndsAt: "2026-07-17T12:00:00Z",
    votesFor: 45000,
    votesAgainst: 98700,
    proposer: "GPROPOSER4DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDWHF",
  },
  {
    id: "prop-5",
    title: "Add Anchor Oracle Network to Mainnet registry",
    summary: "Extend Anchor Oracle Network's authorization from Testnet to Mainnet.",
    description:
      "Anchor Oracle Network has operated reliably on Testnet for 90 days. This proposal extends its authorization to Mainnet, pending community approval.",
    status: "pending",
    createdAt: "2026-10-18T08:00:00Z",
    votingEndsAt: "2026-11-01T08:00:00Z",
    votesFor: 0,
    votesAgainst: 0,
    proposer: "GPROPOSER5EEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEEWHF",
  },
];

function simulateDelay(ms = 600): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Configuration from environment (mirrors verificationService's contract wiring)
const HORIZON_URL = process.env.NEXT_PUBLIC_VITE_HORIZON_URL || 'https://horizon-testnet.stellar.org';
const NETWORK_PASSPHRASE = process.env.NEXT_PUBLIC_VITE_NETWORK_PASSPHRASE || StellarSDK.Networks.TESTNET;
const GOVERNANCE_CONTRACT_ID = process.env.NEXT_PUBLIC_VITE_GOVERNANCE_CONTRACT_ID || '';

const server = new StellarSDK.Horizon.Server(HORIZON_URL);

function choiceToScVal(choice: VoteChoice): InstanceType<typeof StellarSDK.xdr.ScVal> {
  // Represent the vote choice as a Soroban symbol so it maps directly onto a
  // `vote(voter: Address, proposal_id: u64, choice: Symbol)` contract entrypoint.
  return StellarSDK.xdr.ScVal.scvSymbol(choice);
}

export interface CastVoteResult {
  txHash: string;
  proposalId: string;
  choice: VoteChoice;
}

/**
 * Builds, signs (via Freighter), and submits an XLM-weighted governance vote
 * transaction against the on-chain voting contract.
 */
export async function castVote(
  proposalId: string,
  choice: VoteChoice,
  publicKey: string
): Promise<CastVoteResult> {
  if (!GOVERNANCE_CONTRACT_ID) {
    throw new Error('Governance contract ID not configured. Please check your environment variables.');
  }

  if (!publicKey) {
    throw new Error('Connect a wallet before voting.');
  }

  try {
    const networkDetails = await walletService.getNetworkDetails();
    const networkPassphrase = networkDetails?.networkPassphrase || NETWORK_PASSPHRASE;

    const account = await server.loadAccount(publicKey);
    const contract = new StellarSDK.Contract(GOVERNANCE_CONTRACT_ID);

    const params = [
      StellarSDK.Address.fromString(publicKey).toScVal(),
      StellarSDK.nativeToScVal(proposalId, { type: 'u64' }),
      choiceToScVal(choice),
    ];

    const transaction = new StellarSDK.TransactionBuilder(account, {
      fee: StellarSDK.BASE_FEE,
      networkPassphrase,
    })
      .addOperation(contract.call('vote', ...params))
      .setTimeout(30)
      .build();

    const signedResult = await signTransaction(transaction.toXDR(), {
      address: publicKey,
      networkPassphrase,
    });

    const signedXDR = signedResult?.signedTxXdr;
    if (!signedXDR) {
      throw new Error('No signed transaction XDR returned from Freighter');
    }

    const submitted = await server.submitTransaction(
      StellarSDK.TransactionBuilder.fromXDR(signedXDR, networkPassphrase)
    );

    return {
      txHash: submitted.hash,
      proposalId,
      choice,
    };
  } catch (error) {
    if (error instanceof Error) {
      if (
        error.message.includes('User declined') ||
        error.message.includes('rejected') ||
        error.message.includes('Rejected')
      ) {
        throw new Error('You declined the signing request.');
      }

      if (error.message.includes('tx_bad_seq')) {
        throw new Error('Transaction sequence error. Please try again.');
      }

      if (error.message.includes('insufficient balance')) {
        throw new Error('Insufficient balance to submit your vote.');
      }

      throw error;
    }

    throw new Error('An unexpected error occurred while casting your vote.');
  }
}

/**
 * DAO Governance Service
 * Provides mock proposal data and voting operations for governance proposals
 * (e.g. approving new Oracle TEE hashes, provider onboarding, etc).
 * Replace mock calls with real Soroban RPC / contract calls once a
 * governance contract is deployed.
 *
 * @module services/governanceService
 */
export const governanceService = {
  /** Lists all governance proposals, active and historical. */
  async listProposals(): Promise<Proposal[]> {
    await simulateDelay();
    return MOCK_PROPOSALS;
  },

  /** Fetches a single proposal by id, or null if not found. */
  async getProposal(proposalId: string): Promise<Proposal | null> {
    await simulateDelay(400);
    return MOCK_PROPOSALS.find((p) => p.id === proposalId) ?? null;
  },

  /**
   * Casts a vote for the given proposal. In the absence of a deployed
   * governance contract, this simulates a Soroban transaction submission
   * and returns a mock transaction hash. Swap this implementation for a
   * real `invokeContract` call once the governance contract ships.
   */
  async castVote(
    proposalId: string,
    choice: VoteChoice,
    voterAddress: string
  ): Promise<VoteResult> {
    if (!voterAddress) {
      throw new Error("A connected wallet address is required to vote");
    }
    const proposal = MOCK_PROPOSALS.find((p) => p.id === proposalId);
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`);
    }
    if (proposal.status !== "active") {
      throw new Error("Voting is closed for this proposal");
    }
    await simulateDelay(900);
    if (choice === "for") proposal.votesFor += 1;
    else if (choice === "against") proposal.votesAgainst += 1;
    return {
      proposalId,
      choice,
      transactionHash: generateMockTxHash(),
      castAt: new Date().toISOString(),
    };
  },
};

function generateMockTxHash(): string {
  const chars = "0123456789abcdef";
  let hash = "";
  for (let i = 0; i < 64; i += 1) {
    hash += chars[Math.floor(Math.random() * chars.length)];
  }
  return hash;
}
