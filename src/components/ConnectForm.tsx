"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { HypoutLogo } from "@hypout/react";
import { guessBaseUrl, validBaseUrl, type Connection } from "../lib/connection";

export function ConnectForm({ onConnect, initialError }: { onConnect(c: Connection): void; initialError?: string }): ReactNode {
  const [server, setServer] = useState(guessBaseUrl);
  const [token, setToken] = useState("");
  const [error, setError] = useState(initialError ?? "");

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const baseUrl = validBaseUrl(server);
    if (!baseUrl) return setError("The server address must start with http:// or https://");
    if (!token.trim().startsWith("hpt_")) return setError("Admin tokens start with hpt_. Run `hypout token mint --sub me --admin`, or open the link `hypout studio` prints.");
    onConnect({ baseUrl, token: token.trim() });
  };

  return (
    <main className="mx-auto grid min-h-screen max-w-md content-center gap-6 px-4 py-10">
      <HypoutLogo size={36} />
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Connect to a Hypout server</h1>
        <p className="mt-1 text-muted">The Studio talks to your own server. Nothing is sent anywhere else.</p>
      </div>
      <form onSubmit={submit} className="grid gap-4" noValidate>
        <label className="grid gap-1">
          <span className="text-muted">Server</span>
          <input className="hy-input" value={server} onChange={(e) => setServer(e.target.value)} inputMode="url" autoComplete="off" spellCheck={false} />
        </label>
        <label className="grid gap-1">
          <span className="text-muted">Admin token</span>
          <input className="hy-input" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="hpt_…" autoComplete="off" spellCheck={false} />
        </label>
        {error ? (
          <p role="alert" className="text-danger">
            {error}
          </p>
        ) : null}
        <button type="submit" className="hy-btn hy-btn-primary justify-self-start">
          Connect
        </button>
      </form>
    </main>
  );
}
