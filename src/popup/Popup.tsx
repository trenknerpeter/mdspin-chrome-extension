import { useState, useRef, useEffect } from "preact/hooks";
import { createClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";

// ── Supabase ────────────────────────────────────────────────────────
const SUPABASE_URL = "https://ixdsddfxkrkytiitfici.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4ZHNkZGZ4a3JreXRpaXRmaWNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0MzA5MTAsImV4cCI6MjA4OTAwNjkxMH0.rMQEKVnBkTAM6Dxx3OLXF1s-k_coJfn36IQEAqbh36k";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ── Usage limits ───────────────────────────────────────────────────
const ANON_LIMIT = 3;
const AUTH_LIMIT = 20;

// ── File conversion constants ───────────────────────────────────────
const SUPPORTED_TYPES = [
  "application/pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "text/plain",
  "text/html",
  "text/csv",
  "application/rtf",
];
const SUPPORTED_EXTENSIONS = [".pdf", ".docx", ".pptx", ".txt", ".html", ".rtf", ".csv"];
const MAX_FILE_SIZE = 20 * 1024 * 1024;

type ConvertState =
  | { kind: "idle" }
  | { kind: "converting"; fileName: string }
  | { kind: "result"; markdown: string; fileName: string; wordCount: number }
  | { kind: "error"; message: string };

function isSupported(file: File): boolean {
  if (SUPPORTED_TYPES.includes(file.type)) return true;
  const ext = "." + file.name.split(".").pop()?.toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}
function countWords(t: string) {
  return t.trim().split(/\s+/).filter((w) => w.length > 0).length;
}
function getMdFileName(n: string) {
  return n.replace(/\.[^.]+$/, ".md");
}
function getFileExt(name: string): string {
  return (name.split(".").pop() ?? "FILE").toUpperCase().slice(0, 5);
}

// ── Google SVG ──────────────────────────────────────────────────────
function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3c-1.6 4.6-6 8-11.3 8-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3l5.7-5.7C33.9 6.1 29.2 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.2-.1-2.3-.4-3.5z"/>
      <path fill="#FF3D00" d="M6.3 14.7l6.6 4.8C14.7 16 19 12.5 24 12.5c3.1 0 5.8 1.2 7.9 3l5.7-5.7C33.9 6.1 29.2 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"/>
      <path fill="#4CAF50" d="M24 44c5.1 0 9.8-2 13.3-5.2l-6.1-5c-2 1.4-4.5 2.2-7.2 2.2-5.3 0-9.7-3.4-11.3-8l-6.5 5C9.6 39.6 16.2 44 24 44z"/>
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.1-4.1 5.4l6.1 5C41.3 35.4 44 30.1 44 24c0-1.2-.1-2.3-.4-3.5z"/>
    </svg>
  );
}

// ── Popup ───────────────────────────────────────────────────────────
export function Popup() {
  // Conversion state
  const [state, setState] = useState<ConvertState>({ kind: "idle" });
  const [dragOver, setDragOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const originalFileRef = useRef<File | null>(null);

  // Inline toggle (persisted)
  const [inlineEnabled, setInlineEnabled] = useState(true);

  // Auth state
  const [user, setUser] = useState<User | null>(null);
  const [authView, setAuthView] = useState<"none" | "signin" | "signup">("none");
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [authLoading, setAuthLoading] = useState(false);
  const [signupSuccess, setSignupSuccess] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showPassword, setShowPassword] = useState(false);

  // Usage / rate limiting
  const [usage, setUsage] = useState<{ remaining: number; limit: number } | null>(null);

  // ── On mount ──────────────────────────────────────────────────────
  useEffect(() => {
    chrome.storage.local.get("inlineButtonEnabled", (result) => {
      setInlineEnabled(result.inlineButtonEnabled ?? true);
    });

    chrome.storage.local.get("lastConversion", (result) => {
      const cached = result.lastConversion;
      if (cached?.convertedAt) {
        const age = Date.now() - new Date(cached.convertedAt).getTime();
        const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000;
        if (age < TWENTY_FOUR_HOURS) {
          setState({ kind: "result", markdown: cached.markdownText, fileName: cached.fileName, wordCount: cached.wordCount });
        } else {
          chrome.storage.local.remove("lastConversion");
        }
      }
    });

    supabase.auth.getSession().then(({ data }) => {
      const sessionUser = data.session?.user ?? null;
      setUser(sessionUser);
      loadUsage(sessionUser);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const sessionUser = session?.user ?? null;
      setUser(sessionUser);
      loadUsage(sessionUser);
      if (sessionUser) {
        setAuthView("none");
        setAuthEmail("");
        setAuthPassword("");
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  // ── Inline toggle ─────────────────────────────────────────────────
  function toggleInlineButton() {
    const newVal = !inlineEnabled;
    setInlineEnabled(newVal);
    chrome.storage.local.set({ inlineButtonEnabled: newVal });
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0]?.id) {
        chrome.tabs
          .sendMessage(tabs[0].id, { type: "TOGGLE_INLINE_BUTTON", enabled: newVal })
          .catch(() => {});
      }
    });
  }

  // ── Auth helpers ──────────────────────────────────────────────────
  function openAuthView(view: "signin" | "signup") {
    setAuthView(view);
    setAuthEmail("");
    setAuthPassword("");
    setAuthError(null);
    setAuthLoading(false);
    setSignupSuccess(false);
    setShowUserMenu(false);
    setShowPassword(false);
  }

  async function handleSignIn(e: Event) {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    const { error } = await supabase.auth.signInWithPassword({
      email: authEmail,
      password: authPassword,
    });
    if (error) setAuthError(error.message);
    setAuthLoading(false);
  }

  async function handleSignUp(e: Event) {
    e.preventDefault();
    setAuthLoading(true);
    setAuthError(null);
    const { error } = await supabase.auth.signUp({
      email: authEmail,
      password: authPassword,
      options: { emailRedirectTo: "https://mdspin.app/auth/callback" },
    });
    if (error) setAuthError(error.message);
    else setSignupSuccess(true);
    setAuthLoading(false);
  }

  async function handleGoogleSignIn() {
    setAuthLoading(true);
    setAuthError(null);

    try {
      const redirectUrl = chrome.identity.getRedirectURL();
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          skipBrowserRedirect: true,
          redirectTo: redirectUrl,
        },
      });

      if (error || !data?.url) {
        setAuthError(error?.message ?? "Failed to start Google sign-in");
        setAuthLoading(false);
        return;
      }

      const responseUrl = await new Promise<string>((resolve, reject) => {
        chrome.identity.launchWebAuthFlow(
          { url: data.url, interactive: true },
          (callbackUrl) => {
            if (chrome.runtime.lastError || !callbackUrl) {
              reject(new Error(chrome.runtime.lastError?.message ?? "Auth cancelled"));
            } else {
              resolve(callbackUrl);
            }
          }
        );
      });

      const fragment = responseUrl.includes("#") ? responseUrl.split("#")[1] : responseUrl.split("?")[1];
      const hashParams = new URLSearchParams(fragment);
      const access_token = hashParams.get("access_token");
      const refresh_token = hashParams.get("refresh_token");

      if (!access_token || !refresh_token) {
        setAuthError("No tokens received from Google sign-in");
        setAuthLoading(false);
        return;
      }

      const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
        access_token,
        refresh_token,
      });

      if (sessionError) {
        setAuthError(sessionError.message);
      } else if (sessionData?.user) {
        window.location.reload();
      }
    } catch (err: any) {
      if (!err.message?.includes("cancelled") && !err.message?.includes("closed")) {
        setAuthError(err.message ?? "Google sign-in failed");
      }
    } finally {
      setAuthLoading(false);
    }
  }

  async function handleSignOut() {
    await supabase.auth.signOut();
    setUser(null);
    setShowUserMenu(false);
    loadUsage(null);
  }

  // ── Usage / rate limiting ─────────────────────────────────────────
  async function loadUsage(currentUser: User | null) {
    const todayUtc = new Date().toISOString().split("T")[0];
    if (!currentUser) {
      chrome.storage.local.get("dailyUsage", (result) => {
        const stored = result.dailyUsage as { date: string; count: number } | undefined;
        const count = stored?.date === todayUtc ? stored.count : 0;
        setUsage({ remaining: Math.max(0, ANON_LIMIT - count), limit: ANON_LIMIT });
      });
    } else {
      const { data } = await supabase
        .from("daily_usage")
        .select("conversion_count")
        .eq("identifier", currentUser.id)
        .eq("identifier_type", "user")
        .eq("date", todayUtc)
        .maybeSingle();
      const count = data?.conversion_count ?? 0;
      setUsage({ remaining: Math.max(0, AUTH_LIMIT - count), limit: AUTH_LIMIT });
    }
  }

  async function incrementUsage(currentUser: User | null) {
    const todayUtc = new Date().toISOString().split("T")[0];
    if (!currentUser) {
      chrome.storage.local.get("dailyUsage", (result) => {
        const stored = result.dailyUsage as { date: string; count: number } | undefined;
        const count = stored?.date === todayUtc ? stored.count : 0;
        const newCount = count + 1;
        chrome.storage.local.set({ dailyUsage: { date: todayUtc, count: newCount } });
        setUsage({ remaining: Math.max(0, ANON_LIMIT - newCount), limit: ANON_LIMIT });
      });
    } else {
      setUsage((prev) => (prev ? { ...prev, remaining: Math.max(0, prev.remaining - 1) } : null));
      const { data } = await supabase
        .from("daily_usage")
        .select("conversion_count")
        .eq("identifier", currentUser.id)
        .eq("identifier_type", "user")
        .eq("date", todayUtc)
        .maybeSingle();
      const currentCount = data?.conversion_count ?? 0;
      await supabase.from("daily_usage").upsert(
        {
          identifier: currentUser.id,
          identifier_type: "user",
          date: todayUtc,
          conversion_count: currentCount + 1,
          updated_at: new Date().toISOString(),
        },
        { onConflict: "identifier,identifier_type,date" }
      );
      await loadUsage(currentUser);
    }
  }

  // ── File conversion helpers ───────────────────────────────────────
  async function handleFile(file: File) {
    if (!isSupported(file)) {
      setState({ kind: "error", message: `Unsupported file type. Supported: ${SUPPORTED_EXTENSIONS.join(", ")}` });
      return;
    }
    if (file.size > MAX_FILE_SIZE) {
      setState({ kind: "error", message: "File is too large. Maximum size is 20 MB." });
      return;
    }
    if (usage === null) {
      setState({ kind: "error", message: "Checking your conversion quota, please try again." });
      return;
    }
    if (usage.remaining <= 0) {
      setState({
        kind: "error",
        message: user
          ? `Daily limit of ${usage.limit} conversions reached. Resets at midnight UTC.`
          : `Daily limit reached. Sign in for ${AUTH_LIMIT} conversions/day.`,
      });
      return;
    }
    originalFileRef.current = file;
    setState({ kind: "converting", fileName: file.name });
    chrome.storage.local.remove("lastConversion");
    try {
      const response = await chrome.runtime.sendMessage({
        type: "CONVERT_FILE",
        fileName: file.name,
        fileData: await fileToBase64(file),
        fileType: file.type,
      });
      if (response.error) {
        setState({ kind: "error", message: response.error });
      } else {
        const wordCount = countWords(response.markdown);
        setState({ kind: "result", markdown: response.markdown, fileName: file.name, wordCount });
        chrome.storage.local.set({
          lastConversion: { markdownText: response.markdown, fileName: file.name, wordCount, convertedAt: new Date().toISOString() },
        });
        incrementUsage(user).catch((err) => console.error("[MDSpin] Usage increment failed:", err));
      }
    } catch {
      setState({ kind: "error", message: "Conversion failed. Please try again." });
    }
  }

  function fileToBase64(file: File): Promise<string> {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve((reader.result as string).split(",")[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  async function handleCopy() {
    if (state.kind !== "result") return;
    await navigator.clipboard.writeText(state.markdown);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleSaveMd() {
    if (state.kind !== "result") return;
    const blob = new Blob([state.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = getMdFileName(state.fileName);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  function handleDragStartOriginal(e: DragEvent) {
    const file = originalFileRef.current;
    if (!file) return;
    e.dataTransfer!.items.add(file);
    e.dataTransfer!.effectAllowed = "copy";
  }

  function handleDragStartMd(e: DragEvent) {
    if (state.kind !== "result") return;
    const mdFileName = getMdFileName(state.fileName);
    chrome.runtime.sendMessage({
      type: "STORE_PENDING_DROP",
      markdown: state.markdown,
      filename: mdFileName,
    });
    e.dataTransfer!.setData("text/plain", `MDSPIN_DROP:${mdFileName}`);
    e.dataTransfer!.effectAllowed = "copy";
  }

  function handleDragEndMd() {
    chrome.runtime.sendMessage({ type: "CLEAR_PENDING_DROP" });
  }

  function reset() {
    setState({ kind: "idle" });
    setCopied(false);
    originalFileRef.current = null;
    chrome.storage.local.remove("lastConversion");
  }

  const userInitial = user?.email?.[0]?.toUpperCase() ?? "?";

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div class="mds">

      {/* ── Header ── */}
      <header class="mds-header">
        {authView !== "none" ? (
          <button class="auth-back" onClick={() => setAuthView("none")}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
          </button>
        ) : (
          <>
            <div class="mds-logo-img">
              <img src="/icons/mdspin-logo-128x128.png" alt="MDSpin" />
            </div>
            <span class="mds-wordmark">MDSpin</span>
            <div class="mds-header-right">
              <div
                class="mds-inline-chip"
                onClick={toggleInlineButton}
                title={inlineEnabled ? "Inline button: ON — click to disable" : "Inline button: OFF — click to enable"}
              >
                <span class="i">i</span>
                <span>Inline</span>
                <span class="beta">beta</span>
                <div class={`mds-switch${inlineEnabled ? "" : " off"}`} />
              </div>
            </div>
          </>
        )}
      </header>

      {/* ── Auth view ── */}
      {authView !== "none" ? (
        <div class="mds-body signin-body">

          {/* Email verification success */}
          {authView === "signup" && signupSuccess ? (
            <div class="verify-wrap">
              <div class="verify-icon">
                <svg width="24" height="24" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                  <polyline points="22,6 12,13 2,6" />
                </svg>
              </div>
              <p class="verify-title">Check your email</p>
              <p class="verify-sub">
                We sent a confirmation link to <span>{authEmail}</span>. Click it to activate your account.
              </p>
              <button
                onClick={() => setAuthView("none")}
                class="btn btn-ghost"
                style={{ marginTop: "8px", height: "38px", fontSize: "13px" }}
              >
                Back to MDSpin
              </button>
            </div>
          ) : (
            <>
              {/* Hero */}
              <div class="signin-hero">
                <div class="signin-logo-aura">
                  <div class="mds-logo-img" style={{ width: "48px", height: "48px", borderRadius: "14px" }}>
                    <img src="/icons/mdspin-logo-128x128.png" alt="MDSpin" />
                  </div>
                </div>
                <p class="signin-title">
                  {authView === "signin" ? "Welcome back" : "Create account"}
                </p>
                <p class="signin-sub">
                  {authView === "signin"
                    ? "Sign in to sync your spin history across devices"
                    : "Sign up to save your conversion history"}
                </p>
              </div>

              {/* Google */}
              <button class="google-btn" onClick={handleGoogleSignIn} disabled={authLoading}>
                <GoogleIcon />
                <span>Continue with Google</span>
              </button>

              {/* Divider */}
              <div class="signin-divider"><span>or with email</span></div>

              {/* Form */}
              <form onSubmit={authView === "signin" ? handleSignIn : handleSignUp} style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
                <div class="field">
                  <label>Email</label>
                  <div class="input-row">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
                      <polyline points="22,6 12,13 2,6" />
                    </svg>
                    <input
                      type="email"
                      value={authEmail}
                      onInput={(e) => setAuthEmail((e.target as HTMLInputElement).value)}
                      required
                      placeholder="you@example.com"
                    />
                  </div>
                </div>

                <div class="field">
                  <label>Password</label>
                  <div class="input-row">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                    <input
                      type={showPassword ? "text" : "password"}
                      value={authPassword}
                      onInput={(e) => setAuthPassword((e.target as HTMLInputElement).value)}
                      required
                      minLength={authView === "signup" ? 6 : undefined}
                      placeholder={authView === "signup" ? "At least 6 characters" : "Your password"}
                    />
                    <button type="button" class="reveal" onClick={() => setShowPassword(!showPassword)}>
                      {showPassword ? "Hide" : "Show"}
                    </button>
                  </div>
                </div>

                {authError && <p class="auth-error">{authError}</p>}

                <button
                  type="submit"
                  disabled={authLoading}
                  class="btn btn-primary signin-submit"
                >
                  {authLoading
                    ? authView === "signin" ? "Signing in…" : "Creating account…"
                    : authView === "signin" ? "Sign in" : "Create account"}
                </button>
              </form>

              {/* Switch link */}
              <p class="auth-switch">
                {authView === "signin" ? (
                  <>Don't have an account?{" "}
                    <button onClick={() => openAuthView("signup")}>Sign up</button>
                  </>
                ) : (
                  <>Already have an account?{" "}
                    <button onClick={() => openAuthView("signin")}>Sign in</button>
                  </>
                )}
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          {/* ── Main body ── */}
          <div class="mds-body">

            {/* Idle */}
            {state.kind === "idle" && (
              <div class="dropzone">
                <div class={`dz-aura${dragOver ? " active" : ""}`} />
                <div
                  class={`dz-inner${dragOver ? " drag-over" : ""}`}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                  onDragLeave={() => setDragOver(false)}
                  onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer?.files[0]; if (f) handleFile(f); }}
                  onClick={() => inputRef.current?.click()}
                >
                  <input
                    ref={inputRef}
                    type="file"
                    style={{ display: "none" }}
                    accept={SUPPORTED_EXTENSIONS.join(",")}
                    onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) handleFile(f); }}
                  />
                  <div class="dz-upload-icon">
                    <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                      <polyline points="17 8 12 3 7 8" />
                      <line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                  </div>
                  <div class="dz-title">
                    Drop a file here or <span class="dz-browse">browse</span>
                  </div>
                  <div class="dz-sub">Drag from desktop, paste a URL, or pick one</div>
                  <div class="dz-chips">
                    {["PDF", "DOCX", "PPTX", "TXT", "HTML", "RTF", "CSV"].map((t) => (
                      <span key={t} class="dz-chip">{t}</span>
                    ))}
                  </div>
                  <div class="dz-limit">
                    <span class="dot" /> up to 20 MB
                  </div>
                </div>
              </div>
            )}

            {/* Converting */}
            {state.kind === "converting" && (
              <div class="converting-wrap">
                <div class="converting-orb">
                  <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.9)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 12 m0 -6 a6 6 0 1 1 -5.2 9 a4 4 0 1 1 7 -3 a2 2 0 1 1 -3.2 1.6" />
                    <circle cx="12" cy="12" r="0.8" fill="rgba(255,255,255,0.9)" stroke="none" />
                  </svg>
                </div>
                <div class="converting-filename">{state.fileName}</div>
                <div class="converting-label">Converting…</div>
              </div>
            )}

            {/* Result / Done */}
            {state.kind === "result" && (
              <div class="done" style={{ animation: "fade-in 0.25s ease" }}>
                <div class="done-pair">
                  {/* Source tile */}
                  <div
                    class="done-tile src-tile"
                    draggable={true}
                    onDragStart={handleDragStartOriginal}
                  >
                    <div class="done-thumb">
                      <svg width="22" height="26" viewBox="0 0 24 28" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M14 2H6a2 2 0 0 0-2 2v20a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <polyline points="14 2 14 8 20 8" />
                      </svg>
                      <div class="src-badge">{getFileExt(state.fileName)}</div>
                    </div>
                    <div class="done-name">{state.fileName}</div>
                    <button class="done-remove" onClick={reset}>Remove</button>
                  </div>

                  {/* Connector */}
                  <div class="done-connector">
                    <div class="wire" />
                    <div class="orb">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </div>
                    <div class="wire" />
                  </div>

                  {/* MD tile */}
                  <div
                    class="done-tile"
                    draggable={true}
                    onDragStart={handleDragStartMd}
                    onDragEnd={handleDragEndMd}
                  >
                    <div class="done-thumb md-thumb">
                      <div class="md-glyph">MD</div>
                    </div>
                    <div class="done-name">{getMdFileName(state.fileName)}</div>
                    <div class="done-meta">{state.wordCount.toLocaleString()} words</div>
                  </div>
                </div>

                <div class="done-actions">
                  <button class="btn btn-ghost" onClick={handleSaveMd}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                    </svg>
                    Save .md
                  </button>
                  <button class="btn btn-ghost" onClick={handleCopy}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                      <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                    </svg>
                    {copied ? "Copied!" : "Copy"}
                  </button>
                  <button class="btn btn-primary done-new" onClick={reset}>
                    New
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
                      <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                    </svg>
                  </button>
                </div>
              </div>
            )}

            {/* Error */}
            {state.kind === "error" && (
              <div class="error-wrap">
                <div class="error-icon">
                  <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                  </svg>
                </div>
                <p class="error-msg">{state.message}</p>
                {!user && state.message.includes("limit") && (
                  <button class="btn btn-primary" style={{ height: "40px", fontSize: "13px" }} onClick={() => openAuthView("signin")}>
                    Sign in for more
                  </button>
                )}
                <button class="btn btn-ghost" style={{ height: "38px", fontSize: "13px" }} onClick={reset}>
                  Try again
                </button>
              </div>
            )}
          </div>

          {/* ── Footer ── */}
          <footer class="mds-footer">
            <div>
              Powered by{" "}
              <a href="https://mdspin.app" target="_blank" rel="noopener">mdspin.app</a>
            </div>
            <div class="right">
              {usage !== null && (
                <div class={`pill${usage.remaining <= 1 ? " warn" : ""}`}>
                  <b>{usage.remaining}</b>
                  <span style={{ opacity: 0.5 }}>/</span>
                  {usage.limit}
                  <span style={{ opacity: 0.6 }}> spins</span>
                </div>
              )}
              {user ? (
                <div class="user-menu-wrap">
                  <div
                    class="avatar"
                    onClick={() => setShowUserMenu(!showUserMenu)}
                    title={user.email}
                  >
                    {userInitial}
                  </div>
                  {showUserMenu && (
                    <div class="user-menu">
                      <div class="user-menu-email">{user.email}</div>
                      <button class="user-menu-signout" onClick={handleSignOut}>Sign out</button>
                    </div>
                  )}
                </div>
              ) : (
                <div
                  class="avatar"
                  onClick={() => openAuthView("signin")}
                  title="Sign in"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                    <circle cx="12" cy="7" r="4" />
                  </svg>
                </div>
              )}
            </div>
          </footer>
        </>
      )}
    </div>
  );
}
