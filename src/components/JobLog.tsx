"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { Badge, statusTone } from "./ui";

/**
 * Follows a job's log over SSE. When the job reaches a terminal state the page
 * is refreshed so the guest's status, address and specs reflect what the apply
 * actually did.
 */
export function JobLog({
  jobId,
  initialState,
}: {
  jobId: string;
  initialState: string;
}) {
  const [lines, setLines] = useState("");
  const [state, setState] = useState(initialState);
  const boxRef = useRef<HTMLPreElement>(null);
  const stickToBottom = useRef(true);
  const router = useRouter();

  useEffect(() => {
    if (state === "OK" || state === "FAILED" || state === "CANCELLED") return;

    const source = new EventSource(`/api/jobs/${jobId}/stream`);

    source.addEventListener("log", (e) => {
      setLines((prev) => prev + (e as MessageEvent<string>).data + "\n");
    });

    source.addEventListener("done", (e) => {
      try {
        const payload = JSON.parse((e as MessageEvent<string>).data) as {
          state: string;
        };
        setState(payload.state);
      } catch {
        setState("FAILED");
      }
      source.close();
      router.refresh();
    });

    source.onerror = () => source.close();

    return () => source.close();
  }, [jobId, state, router]);

  // Only auto-scroll while the user is already at the bottom; yanking the view
  // away from someone reading an error is worse than not following.
  useEffect(() => {
    const box = boxRef.current;
    if (box && stickToBottom.current) box.scrollTop = box.scrollHeight;
  }, [lines]);

  return (
    <div>
      <div className="mb-2 flex items-center gap-3">
        <Badge tone={statusTone(state)}>{state}</Badge>
        {state === "RUNNING" && (
          <span className="text-xs text-muted">streaming…</span>
        )}
      </div>
      <pre
        ref={boxRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          stickToBottom.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="log max-h-96 overflow-auto rounded-md border border-line bg-ink p-3 text-muted"
      >
        {lines || "Waiting for output…"}
      </pre>
    </div>
  );
}
