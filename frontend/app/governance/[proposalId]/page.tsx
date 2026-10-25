/**
 * Proposal Voting UI Component
 * Lets a connected wallet view full proposal details and cast a Yes/No
 * vote on an active governance proposal.
 *
 * @see Issue #655 - Build Proposal Voting UI Component
 */
"use client";

import React, { useCallback, useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  CheckCircle2,
  Clock,
  AlertCircle,
  ThumbsUp,
  ThumbsDown,
  Wallet,
  Loader2,
} from "lucide-react";
import Header from "../../../components/Header";
import { Skeleton } from "../../../components/ui/Skeleton";
import {
  governanceService,
  type Proposal,
  type VoteChoice,
} from "../../../services/governanceService";
import { walletService } from "../../../services/wallet";

function StatusBadge({ status }: { status: Proposal["status"] }) {
  const config: Record<Proposal["status"], { label: string; className: string }> = {
    active: { label: "Active", className: "bg-primary/10 text-primary border-primary/20" },
    pending: { label: "Pending", className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20" },
    passed: { label: "Passed", className: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20" },
    rejected: { label: "Rejected", className: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20" },
  };
  const { label, className } = config[status];
  return (
    <span className={`inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold ${className}`}>
      {label}
    </span>
  );
}

function ProposalSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-8 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-5/6" />
      <Skeleton className="h-40 w-full rounded-2xl" />
    </div>
  );
}

export default function ProposalVotingPage() {
  const params = useParams<{ proposalId: string }>();
  const proposalId = params?.proposalId ?? "";

  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [submittingChoice, setSubmittingChoice] = useState<VoteChoice | null>(null);
  const [voteResult, setVoteResult] = useState<{ choice: VoteChoice; transactionHash: string } | null>(null);
  const [voteError, setVoteError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!proposalId) return;
    governanceService
      .getProposal(proposalId)
      .then((result) => {
        if (cancelled) return;
        if (!result) setNotFound(true);
        else setProposal(result);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load proposal details. Please try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [proposalId]);

  useEffect(() => {
    let cancelled = false;
    walletService
      .getAddress()
      .then((address) => {
        if (!cancelled) setWalletAddress(address);
      })
      .catch(() => {
        /* no wallet connected yet */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleConnectWallet = useCallback(async () => {
    setConnecting(true);
    setVoteError(null);
    try {
      const result = await walletService.requestAccess();
      if (result.address) setWalletAddress(result.address);
      else setVoteError(result.error ?? "Failed to connect wallet");
    } catch {
      setVoteError("Failed to connect wallet");
    } finally {
      setConnecting(false);
    }
  }, []);

  const handleVote = useCallback(
    async (choice: VoteChoice) => {
      if (!proposal) return;
      if (!walletAddress) {
        setVoteError("Connect your wallet before voting");
        return;
      }
      setSubmittingChoice(choice);
      setVoteError(null);
      try {
        const result = await governanceService.castVote(proposal.id, choice, walletAddress);
        setVoteResult({ choice: result.choice, transactionHash: result.transactionHash });
        setProposal((prev) =>
          prev
            ? {
                ...prev,
                votesFor: choice === "for" ? prev.votesFor + 1 : prev.votesFor,
                votesAgainst: choice === "against" ? prev.votesAgainst + 1 : prev.votesAgainst,
              }
            : prev,
        );
      } catch (err) {
        setVoteError(err instanceof Error ? err.message : "Failed to cast vote");
      } finally {
        setSubmittingChoice(null);
      }
    },
    [proposal, walletAddress],
  );

  const canVote = proposal?.status === "active" && !voteResult;

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#020617] font-sans selection:bg-primary/30">
      <Header />

      <main id="main-content" className="mx-auto max-w-3xl px-4 sm:px-6 lg:px-8 py-12">
        <Link
          href="/governance"
          className="inline-flex items-center gap-1.5 text-sm font-medium text-gray-500 dark:text-gray-400 hover:text-primary dark:hover:text-primary mb-6 transition-colors"
        >
          <ArrowLeft className="w-4 h-4" aria-hidden />
          Back to proposals
        </Link>

        {loading && <ProposalSkeleton />}

        {!loading && notFound && (
          <div className="flex flex-col items-center gap-3 py-16 text-center">
            <AlertCircle className="h-8 w-8 text-gray-400 dark:text-gray-500" aria-hidden />
            <p className="text-sm text-gray-500 dark:text-gray-400">
              Proposal &quot;{proposalId}&quot; could not be found.
            </p>
          </div>
        )}

        {!loading && error && (
          <div className="flex items-start gap-3 rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4">
            <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" aria-hidden />
            <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}

        {!loading && proposal && (
          <div className="space-y-6">
            <div>
              <div className="flex items-center gap-3 mb-3">
                <StatusBadge status={proposal.status} />
                <span className="text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1">
                  <Clock className="w-3 h-3" aria-hidden />
                  {proposal.status === "active"
                    ? `Voting ends ${new Date(proposal.votingEndsAt).toLocaleString()}`
                    : `Closed ${new Date(proposal.votingEndsAt).toLocaleDateString()}`}
                </span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-gray-900 dark:text-white">
                {proposal.title}
              </h1>
              <p className="mt-3 text-sm text-gray-600 dark:text-gray-300 leading-relaxed">
                {proposal.description}
              </p>
              <p className="mt-3 text-xs font-mono text-gray-400 dark:text-gray-500">
                Proposed by {proposal.proposer.slice(0, 8)}...{proposal.proposer.slice(-6)}
              </p>
            </div>

            <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 p-5 space-y-4">
              <h2 className="text-sm font-semibold text-gray-900 dark:text-white">Current tally</h2>
              <div className="grid grid-cols-2 gap-4">
                <div className="rounded-xl bg-green-50 dark:bg-green-950/20 p-4">
                  <p className="text-xs font-medium text-green-700 dark:text-green-400 mb-1">Votes for</p>
                  <p className="text-2xl font-bold text-green-700 dark:text-green-400">
                    {proposal.votesFor.toLocaleString()}
                  </p>
                </div>
                <div className="rounded-xl bg-red-50 dark:bg-red-950/20 p-4">
                  <p className="text-xs font-medium text-red-700 dark:text-red-400 mb-1">Votes against</p>
                  <p className="text-2xl font-bold text-red-700 dark:text-red-400">
                    {proposal.votesAgainst.toLocaleString()}
                  </p>
                </div>
              </div>
            </div>

            {voteError && (
              <div className="flex items-start gap-3 rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4">
                <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" aria-hidden />
                <p className="text-sm font-medium text-red-700 dark:text-red-300">{voteError}</p>
              </div>
            )}

            {voteResult && (
              <div className="flex items-start gap-3 rounded-xl border border-green-200 dark:border-green-800 bg-green-50 dark:bg-green-950/30 p-4">
                <CheckCircle2 className="w-5 h-5 text-green-600 dark:text-green-400 shrink-0 mt-0.5" aria-hidden />
                <div>
                  <p className="text-sm font-medium text-green-700 dark:text-green-300">
                    Vote &quot;{voteResult.choice === "for" ? "Yes" : "No"}&quot; submitted successfully.
                  </p>
                  <p className="mt-1 text-xs font-mono text-green-600 dark:text-green-400 break-all">
                    tx: {voteResult.transactionHash}
                  </p>
                </div>
              </div>
            )}

            {proposal.status !== "active" && !voteResult && (
              <div className="flex items-start gap-3 rounded-xl border border-gray-200 dark:border-white/10 bg-gray-50 dark:bg-white/[0.02] p-4">
                <AlertCircle className="w-5 h-5 text-gray-400 shrink-0 mt-0.5" aria-hidden />
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  Voting is closed for this proposal.
                </p>
              </div>
            )}

            {canVote && !walletAddress && (
              <button
                type="button"
                onClick={handleConnectWallet}
                disabled={connecting}
                className="flex items-center justify-center gap-2 w-full sm:w-auto px-5 py-3 rounded-xl bg-primary text-white font-medium hover:bg-primary/90 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
              >
                {connecting ? (
                  <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                ) : (
                  <Wallet className="w-4 h-4" aria-hidden />
                )}
                Connect wallet to vote
              </button>
            )}

            {canVote && walletAddress && (
              <div className="space-y-3">
                <p className="text-xs text-gray-400 dark:text-gray-500">
                  Voting as {walletAddress.slice(0, 8)}...{walletAddress.slice(-6)}
                </p>
                <div className="flex flex-col sm:flex-row gap-3">
                  <button
                    type="button"
                    onClick={() => handleVote("for")}
                    disabled={submittingChoice !== null}
                    aria-label="Vote yes"
                    className="flex-1 flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-green-600 text-white font-medium hover:bg-green-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {submittingChoice === "for" ? (
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                    ) : (
                      <ThumbsUp className="w-4 h-4" aria-hidden />
                    )}
                    Vote Yes
                  </button>
                  <button
                    type="button"
                    onClick={() => handleVote("against")}
                    disabled={submittingChoice !== null}
                    aria-label="Vote no"
                    className="flex-1 flex items-center justify-center gap-2 px-5 py-3 rounded-xl bg-red-600 text-white font-medium hover:bg-red-700 disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
                  >
                    {submittingChoice === "against" ? (
                      <Loader2 className="w-4 h-4 animate-spin" aria-hidden />
                    ) : (
                      <ThumbsDown className="w-4 h-4" aria-hidden />
                    )}
                    Vote No
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}
