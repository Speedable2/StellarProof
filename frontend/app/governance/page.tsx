/**
 * DAO Governance Proposals List View
 * Displays all active and historical governance proposals (e.g. approving
 * new Oracle TEE hashes, onboarding providers) with their current voting
 * status, and links into the individual proposal/voting page.
 *
 * @see Issue #654 - DAO Governance Proposals List View
 */
"use client";

import React, { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Vote,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  ChevronRight,
} from "lucide-react";
import Header from "../../components/Header";
import { Skeleton } from "../../components/ui/Skeleton";
import {
  governanceService,
  type Proposal,
  type ProposalStatus,
} from "../../services/governanceService";

const STATUS_FILTERS: { label: string; value: ProposalStatus | "all" }[] = [
  { label: "All", value: "all" },
  { label: "Active", value: "active" },
  { label: "Pending", value: "pending" },
  { label: "Passed", value: "passed" },
  { label: "Rejected", value: "rejected" },
];

function StatusBadge({ status }: { status: ProposalStatus }) {
  const config: Record<ProposalStatus, { label: string; className: string; Icon: typeof CheckCircle2 }> = {
    active: {
      label: "Active",
      className: "bg-primary/10 text-primary border-primary/20",
      Icon: Vote,
    },
    pending: {
      label: "Pending",
      className: "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20",
      Icon: Clock,
    },
    passed: {
      label: "Passed",
      className: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
      Icon: CheckCircle2,
    },
    rejected: {
      label: "Rejected",
      className: "bg-red-500/10 text-red-600 dark:text-red-400 border-red-500/20",
      Icon: XCircle,
    },
  };
  const { label, className, Icon } = config[status];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-semibold ${className}`}
    >
      <Icon className="w-3 h-3" aria-hidden />
      {label}
    </span>
  );
}

function VoteBar({ votesFor, votesAgainst }: { votesFor: number; votesAgainst: number }) {
  const total = votesFor + votesAgainst;
  const forPct = total === 0 ? 0 : Math.round((votesFor / total) * 100);
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs text-gray-500 dark:text-gray-400">
        <span>{votesFor.toLocaleString()} for</span>
        <span>{votesAgainst.toLocaleString()} against</span>
      </div>
      <div className="h-1.5 w-full rounded-full bg-gray-200 dark:bg-white/10 overflow-hidden">
        <div
          className="h-full rounded-full bg-primary"
          style={{ width: total === 0 ? "0%" : `${forPct}%` }}
        />
      </div>
    </div>
  );
}

function ProposalCard({ proposal }: { proposal: Proposal }) {
  const endsLabel = new Date(proposal.votingEndsAt).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });

  return (
    <Link
      href={`/governance/${proposal.id}`}
      className="group block rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 p-5 hover:border-primary/40 dark:hover:border-primary/30 hover:shadow-sm transition-all"
    >
      <div className="flex items-start justify-between gap-4 mb-3">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-gray-900 dark:text-white group-hover:text-primary transition-colors">
            {proposal.title}
          </h3>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400 line-clamp-2">
            {proposal.summary}
          </p>
        </div>
        <ChevronRight className="w-5 h-5 text-gray-400 shrink-0 group-hover:translate-x-0.5 group-hover:text-primary transition-all" aria-hidden />
      </div>
      <div className="flex items-center justify-between gap-4 mb-3">
        <StatusBadge status={proposal.status} />
        <span className="text-xs text-gray-400 dark:text-gray-500 flex items-center gap-1">
          <Clock className="w-3 h-3" aria-hidden />
          {proposal.status === "active" ? `Ends ${endsLabel}` : `Closed ${endsLabel}`}
        </span>
      </div>
      <VoteBar votesFor={proposal.votesFor} votesAgainst={proposal.votesAgainst} />
    </Link>
  );
}

function ProposalCardSkeleton() {
  return (
    <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-white dark:bg-white/5 p-5 space-y-3">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-1/3" />
      <Skeleton className="h-1.5 w-full rounded-full" />
    </div>
  );
}

export default function GovernancePage() {
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ProposalStatus | "all">("all");

  useEffect(() => {
    let cancelled = false;
    governanceService
      .listProposals()
      .then((result) => {
        if (!cancelled) setProposals(result);
      })
      .catch(() => {
        if (!cancelled) setError("Failed to load governance proposals. Please try again.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const filteredProposals = useMemo(
    () =>
      filter === "all" ? proposals : proposals.filter((p) => p.status === filter),
    [proposals, filter],
  );

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#020617] font-sans selection:bg-primary/30">
      <Header />

      <main id="main-content" className="mx-auto max-w-5xl px-4 sm:px-6 lg:px-8 py-12">
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white">
            Governance
          </h1>
          <p className="mt-2 text-base text-gray-500 dark:text-gray-400">
            Review active and past DAO proposals, including Oracle hash approvals and provider onboarding.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2 mb-6">
          {STATUS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              onClick={() => setFilter(f.value)}
              aria-pressed={filter === f.value}
              className={`px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                filter === f.value
                  ? "bg-primary text-white shadow-button-glow"
                  : "bg-white dark:bg-white/5 text-gray-600 dark:text-gray-300 border border-gray-200 dark:border-white/10 hover:border-primary/40 hover:text-primary"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {error && (
          <div className="mb-6 flex items-start gap-3 rounded-xl border border-red-200 dark:border-red-800 bg-red-50 dark:bg-red-950/30 p-4">
            <AlertCircle className="w-5 h-5 text-red-600 dark:text-red-400 shrink-0 mt-0.5" aria-hidden />
            <p className="text-sm font-medium text-red-700 dark:text-red-300">{error}</p>
          </div>
        )}

        <div className="space-y-4" role="list" aria-label="Governance proposals">
          {loading ? (
            Array.from({ length: 4 }).map((_, i) => <ProposalCardSkeleton key={i} />)
          ) : filteredProposals.length > 0 ? (
            filteredProposals.map((proposal) => (
              <ProposalCard key={proposal.id} proposal={proposal} />
            ))
          ) : (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <Vote className="h-8 w-8 text-gray-400 dark:text-gray-500" aria-hidden />
              <p className="text-sm text-gray-500 dark:text-gray-400">
                No proposals match this filter.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
