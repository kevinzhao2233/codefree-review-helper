import "./app.css";
import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ReviewHelper, type SubPatch } from "./components/review/ReviewHelper";
import { fetchPatches, submitReview } from "./data";

function App() {
  const [patches, setPatches] = useState<SubPatch[] | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    fetchPatches()
      .then(setPatches)
      .catch((e) => setError(e.message));
  }, []);

  if (error) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <span className="font-[family-name:var(--font-mono)] text-sm text-muted-foreground">
          {error}
        </span>
      </div>
    );
  }

  if (!patches) {
    return (
      <div className="flex h-screen flex-col items-center justify-center gap-3">
        <div className="animate-pulse-dot size-2 rounded-full bg-primary" />
        <span className="font-[family-name:var(--font-mono)] text-xs tracking-widest text-muted-foreground">
          加载中…
        </span>
      </div>
    );
  }

  return (
    <div className="h-screen">
      <ReviewHelper patches={patches} onSubmit={(submission) => submitReview(submission)} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
