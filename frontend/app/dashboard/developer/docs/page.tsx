/**
 * Interactive Swagger/API Docs Viewer
 * Renders the backend's OpenAPI spec (served at `/api-docs.json` by
 * backend/src/docs/swagger.ts) directly in the developer dashboard using
 * Swagger UI React, instead of linking out to the standalone /api-docs
 * page served by the Express app.
 *
 * @see Issue #652 - Add Interactive Swagger/API Docs Viewer Component
 */
"use client";

import React, { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { AlertCircle, Loader2 } from "lucide-react";
import Header from "../../../../components/Header";

// swagger-ui-react reads `window` at module init time, so it must be
// loaded client-side only; ssr: false keeps it out of the server bundle.
const SwaggerUI = dynamic(() => import("swagger-ui-react"), { ssr: false });

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const SPEC_URL = `${API_BASE_URL}/api-docs.json`;

export default function DeveloperApiDocsPage() {
  const [specAvailable, setSpecAvailable] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(SPEC_URL, { method: "GET" })
      .then((res) => {
        if (!cancelled) setSpecAvailable(res.ok);
      })
      .catch(() => {
        if (!cancelled) setSpecAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-[#020617] font-sans">
      <Header />

      <main id="main-content" className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8 py-12">
        <div className="mb-8">
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-gray-900 dark:text-white">
            API Documentation
          </h1>
          <p className="mt-2 text-base text-gray-500 dark:text-gray-400">
            Interactive reference for the StellarProof backend API, generated from the live OpenAPI spec.
          </p>
        </div>

        {specAvailable === null && (
          <div className="flex items-center justify-center gap-2 py-24 text-gray-500 dark:text-gray-400">
            <Loader2 className="w-5 h-5 animate-spin" aria-hidden />
            <span className="text-sm">Loading API specification…</span>
          </div>
        )}

        {specAvailable === false && (
          <div className="flex items-start gap-3 rounded-xl border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-950/30 p-4">
            <AlertCircle className="w-5 h-5 text-amber-600 dark:text-amber-400 shrink-0 mt-0.5" aria-hidden />
            <div>
              <p className="text-sm font-medium text-amber-700 dark:text-amber-300">
                Could not reach the API specification at {SPEC_URL}.
              </p>
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
                Make sure the backend is running locally, or set NEXT_PUBLIC_API_URL to point at a reachable
                StellarProof API instance.
              </p>
            </div>
          </div>
        )}

        {specAvailable && (
          <div className="rounded-2xl border border-gray-200 dark:border-white/10 bg-white overflow-hidden">
            <SwaggerUI url={SPEC_URL} docExpansion="list" defaultModelsExpandDepth={-1} />
          </div>
        )}
      </main>
    </div>
  );
}
