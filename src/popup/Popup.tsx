import { useState, useRef, useEffect } from "preact/hooks";
import { createClient } from "@supabase/supabase-js";
import type { User } from "@supabase/supabase-js";

// ── Supabase ────────────────────────────────────────────────────────
const SUPABASE_URL = "https://ixdsddfxkrkytiitfici.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Iml4ZHNkZGZ4a3JreXRpaXRmaWNpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzM0MzA5MTAsImV4cCI6MjA4OTAwNjkxMH0.rMQEKVnBkTAM6Dxx3OLXF1s-k_coJfn36IQEAqbh36k";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

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

// ── Google SVG ──────────────────────────────────────────────────────
function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
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

  // ── On mount ──────────────────────────────────────────────────────
  useEffect(() => {
    // Load inline toggle preference
    chrome.storage.local.get("inlineButtonEnabled", (result) => {
      setInlineEnabled(result.inlineButtonEnabled ?? true);
    });

    // Load existing Supabase session
    supabase.auth.getSession().then(({ data }) => {
      setUser(data.session?.user ?? null);
    });

    // Listen for auth changes (e.g. after Google OAuth redirect)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setUser(session?.user ?? null);
      if (session?.user) {
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
      console.log("[MDSpin Auth] Redirect URL:", redirectUrl);

      // 1. Get the OAuth URL from Supabase (don't redirect the browser)
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: "google",
        options: {
          skipBrowserRedirect: true,
          redirectTo: redirectUrl,
        },
      });

      console.log("[MDSpin Auth] Supabase OAuth URL:", data?.url);
      console.log("[MDSpin Auth] Supabase OAuth error:", error);

      if (error || !data?.url) {
        setAuthError(error?.message ?? "Failed to start Google sign-in");
        setAuthLoading(false);
        return;
      }

      // 2. Open Chrome's managed auth window
      const responseUrl = await new Promise<string>((resolve, reject) => {
        chrome.identity.launchWebAuthFlow(
          { url: data.url, interactive: true },
          (callbackUrl) => {
            console.log("[MDSpin Auth] launchWebAuthFlow callback URL:", callbackUrl);
            console.log("[MDSpin Auth] lastError:", chrome.runtime.lastError);
            if (chrome.runtime.lastError || !callbackUrl) {
              reject(new Error(chrome.runtime.lastError?.message ?? "Auth cancelled"));
            } else {
              resolve(callbackUrl);
            }
          }
        );
      });

      console.log("[MDSpin Auth] Full response URL:", responseUrl);

      // 3. Parse tokens from the URL fragment
      //    URL: https://<id>.chromiumapp.org/#access_token=...&refresh_token=...
      const fragment = responseUrl.includes("#") ? responseUrl.split("#")[1] : responseUrl.split("?")[1];
      console.log("[MDSpin Auth] URL fragment:", fragment?.substring(0, 100) + "...");

      const hashParams = new URLSearchParams(fragment);
      const access_token = hashParams.get("access_token");
      const refresh_token = hashParams.get("refresh_token");

      console.log("[MDSpin Auth] access_token present:", !!access_token);
      console.log("[MDSpin Auth] refresh_token present:", !!refresh_token);

      if (!access_token || !refresh_token) {
        console.log("[MDSpin Auth] All params:", [...hashParams.keys()]);
        setAuthError("No tokens received from Google sign-in");
        setAuthLoading(false);
        return;
      }

      // 4. Set the session in Supabase
      const { data: sessionData, error: sessionError } = await supabase.auth.setSession({
        access_token,
        refresh_token,
      });

      console.log("[MDSpin Auth] setSession result:", { user: sessionData?.user?.email, error: sessionError });

      if (sessionError) {
        setAuthError(sessionError.message);
      } else if (sessionData?.user) {
        // Explicitly update UI — onAuthStateChange may not fire reliably
        // when the popup was backgrounded during the auth window
        setUser(sessionData.user);
        setAuthView("none");
        setAuthEmail("");
        setAuthPassword("");
      }
    } catch (err: any) {
      console.error("[MDSpin Auth] Error:", err);
      // User closed the auth window or something else went wrong
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
    originalFileRef.current = file;
    setState({ kind: "converting", fileName: file.name });
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
        setState({ kind: "result", markdown: response.markdown, fileName: file.name, wordCount: countWords(response.markdown) });
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
    const mdFile = new File([state.markdown], getMdFileName(state.fileName), { type: "text/markdown" });
    e.dataTransfer!.items.add(mdFile);
    e.dataTransfer!.effectAllowed = "copy";
  }

  function reset() {
    setState({ kind: "idle" });
    setCopied(false);
    originalFileRef.current = null;
  }

  // ── User avatar initial ───────────────────────────────────────────
  const userInitial = user?.email?.[0]?.toUpperCase() ?? "?";

  // ── Input style helper ────────────────────────────────────────────
  const inputStyle = {
    width: "100%",
    padding: "10px 12px",
    borderRadius: "8px",
    background: "#1A1A1A",
    border: "1px solid #2A2A2A",
    color: "#F0EDE8",
    fontSize: "13px",
    outline: "none",
    boxSizing: "border-box" as const,
    fontFamily: "'DM Sans', system-ui, sans-serif",
  };

  // ── Render ─────────────────────────────────────────────────────────
  return (
    <div
      class="w-[420px] h-[520px] flex flex-col rounded-2xl overflow-hidden"
      style={{ background: "#0C0C0C", color: "#F0EDE8", fontFamily: "'DM Sans', system-ui, -apple-system, sans-serif" }}
    >
      {/* ── Header ── */}
      <header class="flex items-center gap-3 px-4 py-3" style={{ borderBottom: "1px solid #2A2A2A" }}>
        <img src="/icons/icon-48.png" alt="MDSpin" class="w-8 h-8 rounded-lg" />
        <h1 class="text-base font-bold tracking-tight" style={{ fontFamily: "'Syne', 'DM Sans', system-ui, sans-serif" }}>
          MDSpin
        </h1>
        {/* Inline toggle */}
        <div
          class="ml-auto flex items-center gap-1.5 cursor-pointer select-none"
          onClick={toggleInlineButton}
          title={inlineEnabled ? "Inline button: ON — click to disable" : "Inline button: OFF — click to enable"}
        >
          <span class="text-[10px]" style={{ color: "#888480" }}>Inline</span>
          <div
            class="relative rounded-full transition-colors duration-200"
            style={{ width: "32px", height: "18px", background: inlineEnabled ? "#FF4800" : "#3A3A3A" }}
          >
            <div
              class="absolute top-[2px] rounded-full transition-all duration-200"
              style={{ width: "14px", height: "14px", background: "#fff", left: inlineEnabled ? "16px" : "2px" }}
            />
          </div>
        </div>
      </header>

      {/* ── Auth view (replaces main + footer) ── */}
      {authView !== "none" ? (
        <div class="flex-1 overflow-auto px-6 py-5 flex flex-col">

          {/* Back button */}
          <button
            onClick={() => setAuthView("none")}
            class="flex items-center gap-1.5 text-xs mb-5 self-start transition-colors duration-150"
            style={{ color: "#888480" }}
            onMouseEnter={(e) => (e.currentTarget.style.color = "#F0EDE8")}
            onMouseLeave={(e) => (e.currentTarget.style.color = "#888480")}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
            Back
          </button>

          {/* Sign-up success state */}
          {authView === "signup" && signupSuccess ? (
            <div class="flex-1 flex flex-col items-center justify-center text-center gap-4">
              <div class="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(255,72,0,0.15)" }}>
                <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="#FF4800" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <div>
                <p class="text-base font-bold mb-1" style={{ fontFamily: "'Syne', sans-serif" }}>Check your email</p>
                <p class="text-xs" style={{ color: "#999" }}>
                  We sent a confirmation link to{" "}
                  <span style={{ color: "#F0EDE8" }}>{authEmail}</span>.
                  Click the link to activate your account.
                </p>
              </div>
              <button
                onClick={() => setAuthView("none")}
                class="text-xs mt-2"
                style={{ color: "#FF4800" }}
              >
                Back to MDSpin
              </button>
            </div>
          ) : (
            <>
              {/* Logo + heading */}
              <div class="text-center mb-5">
                <div class="inline-flex items-center gap-2 mb-4">
                  <div class="w-8 h-8 rounded-lg flex items-center justify-center" style={{ background: "#FF4800" }}>
                    <img src="/icons/icon-48.png" alt="" class="w-6 h-6 rounded-md" />
                  </div>
                  <span class="font-bold text-base" style={{ fontFamily: "'Syne', sans-serif" }}>MDSpin</span>
                </div>
                <h2 class="text-lg font-bold mb-1" style={{ fontFamily: "'Syne', sans-serif" }}>
                  {authView === "signin" ? "Welcome back" : "Create your account"}
                </h2>
                <p class="text-xs" style={{ color: "#999" }}>
                  {authView === "signin" ? "Sign in to access your spin history" : "Sign up to save your conversion history"}
                </p>
              </div>

              {/* Google button */}
              <button
                onClick={handleGoogleSignIn}
                class="w-full flex items-center justify-center gap-2.5 py-2.5 px-4 rounded-lg text-sm mb-4 transition-colors duration-150"
                style={{ background: "#1A1A1A", border: "1px solid #2A2A2A", color: "#F0EDE8" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = "#222")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "#1A1A1A")}
              >
                <GoogleIcon />
                Continue with Google
              </button>

              {/* Divider */}
              <div class="flex items-center gap-3 mb-4">
                <div class="flex-1 h-px" style={{ background: "#2A2A2A" }} />
                <span class="text-[11px]" style={{ color: "#666" }}>or</span>
                <div class="flex-1 h-px" style={{ background: "#2A2A2A" }} />
              </div>

              {/* Form */}
              <form onSubmit={authView === "signin" ? handleSignIn : handleSignUp} style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                <div>
                  <label class="block text-xs mb-1.5" style={{ color: "#999" }}>Email</label>
                  <input
                    type="email"
                    value={authEmail}
                    onInput={(e) => setAuthEmail((e.target as HTMLInputElement).value)}
                    required
                    placeholder="you@example.com"
                    style={inputStyle}
                  />
                </div>
                <div>
                  <label class="block text-xs mb-1.5" style={{ color: "#999" }}>Password</label>
                  <input
                    type="password"
                    value={authPassword}
                    onInput={(e) => setAuthPassword((e.target as HTMLInputElement).value)}
                    required
                    minLength={authView === "signup" ? 6 : undefined}
                    placeholder={authView === "signup" ? "At least 6 characters" : "Your password"}
                    style={inputStyle}
                  />
                </div>

                {authError && (
                  <p class="text-xs" style={{ color: "#f87171" }}>{authError}</p>
                )}

                <button
                  type="submit"
                  disabled={authLoading}
                  class="w-full py-2.5 rounded-lg text-sm font-semibold transition-colors duration-150"
                  style={{ background: authLoading ? "#994400" : "#FF4800", color: "#fff", opacity: authLoading ? 0.7 : 1 }}
                  onMouseEnter={(e) => { if (!authLoading) (e.currentTarget as HTMLElement).style.background = "#E04200"; }}
                  onMouseLeave={(e) => { if (!authLoading) (e.currentTarget as HTMLElement).style.background = "#FF4800"; }}
                >
                  {authLoading
                    ? authView === "signin" ? "Signing in..." : "Creating account..."
                    : authView === "signin" ? "Sign in" : "Create account"}
                </button>
              </form>

              {/* Switch view link */}
              <p class="text-center text-xs mt-4" style={{ color: "#666" }}>
                {authView === "signin" ? (
                  <>Don't have an account?{" "}
                    <button onClick={() => openAuthView("signup")} class="transition-colors" style={{ color: "#FF4800" }}
                      onMouseEnter={(e) => ((e.target as HTMLElement).style.textDecoration = "underline")}
                      onMouseLeave={(e) => ((e.target as HTMLElement).style.textDecoration = "none")}
                    >Sign up</button>
                  </>
                ) : (
                  <>Already have an account?{" "}
                    <button onClick={() => openAuthView("signin")} class="transition-colors" style={{ color: "#FF4800" }}
                      onMouseEnter={(e) => ((e.target as HTMLElement).style.textDecoration = "underline")}
                      onMouseLeave={(e) => ((e.target as HTMLElement).style.textDecoration = "none")}
                    >Sign in</button>
                  </>
                )}
              </p>
            </>
          )}
        </div>
      ) : (
        <>
          {/* ── Main content ── */}
          <main class="flex-1 overflow-auto p-4">
            {state.kind === "idle" && (
              <div
                class={`h-full border-2 border-dashed rounded-xl flex flex-col items-center justify-center gap-3 cursor-pointer transition-all duration-200 ${dragOver ? "scale-[1.01]" : ""}`}
                style={{ borderColor: dragOver ? "#FF4800" : "#2A2A2A", background: dragOver ? "rgba(255,72,0,0.08)" : "#161616" }}
                onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer?.files[0]; if (f) handleFile(f); }}
                onClick={() => inputRef.current?.click()}
              >
                <input ref={inputRef} type="file" class="hidden" accept={SUPPORTED_EXTENSIONS.join(",")}
                  onChange={(e) => { const f = (e.target as HTMLInputElement).files?.[0]; if (f) handleFile(f); }} />
                <svg class="w-10 h-10" style={{ color: "#888480" }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
                </svg>
                <p class="text-sm font-medium">Drop a file here or <span style={{ color: "#FF4800" }}>browse</span></p>
                <p class="text-xs" style={{ color: "#888480" }}>PDF, DOCX, PPTX, TXT, HTML, RTF, CSV — up to 20 MB</p>
              </div>
            )}

            {state.kind === "converting" && (
              <div class="h-full flex flex-col items-center justify-center gap-4">
                <div class="w-10 h-10 border-3 border-t-transparent rounded-full animate-spin" style={{ borderColor: "#FF4800", borderTopColor: "transparent" }} />
                <p class="text-sm font-medium">{state.fileName}</p>
                <p class="text-xs" style={{ color: "#888480" }}>Converting with MDSpin...</p>
              </div>
            )}

            {state.kind === "result" && (
              <div key={state.fileName} class="h-full flex flex-col items-center justify-center gap-2">
                {/* Original file */}
                <div draggable={true} onDragStart={handleDragStartOriginal} class="flex flex-col items-center gap-1.5 cursor-grab active:cursor-grabbing" style={{ animation: "fade-in 0.3s ease both" }}>
                  <div class="w-14 h-14 rounded-xl flex items-center justify-center" style={{ background: "#1E1E1E" }}>
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#888480" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                      <polyline points="14 2 14 8 20 8" />
                      <line x1="16" y1="13" x2="8" y2="13" />
                      <line x1="16" y1="17" x2="8" y2="17" />
                    </svg>
                  </div>
                  <span class="text-xs font-medium truncate max-w-[240px]">{state.fileName}</span>
                  <button onClick={reset} class="text-[10px] transition-colors duration-150" style={{ color: "#888480" }}
                    onMouseEnter={(e) => ((e.target as HTMLElement).style.color = "#F0EDE8")}
                    onMouseLeave={(e) => ((e.target as HTMLElement).style.color = "#888480")}
                  >Remove</button>
                </div>

                {/* Arrow */}
                <div class="flex flex-col items-center py-2" style={{ animation: "slide-down 0.4s ease 0.3s both" }}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                    <path d="M12 4v12m0 0l-5-5m5 5l5-5" stroke="#FF4800" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
                    <circle cx="12" cy="20" r="1.5" fill="#FF4800" />
                  </svg>
                </div>

                {/* MD file */}
                <div draggable={true} onDragStart={handleDragStartMd} class="flex flex-col items-center gap-1.5 cursor-grab active:cursor-grabbing" style={{ animation: "fade-in-up 0.4s ease 0.5s both" }}>
                  <div class="w-14 h-14 rounded-xl flex items-center justify-center" style={{ background: "#1E1E1E", border: "1.5px solid #FF4800" }}>
                    <span class="text-sm font-bold" style={{ color: "#F0EDE8" }}>MD</span>
                  </div>
                  <span class="text-xs font-medium truncate max-w-[240px]">{getMdFileName(state.fileName)}</span>
                </div>
              </div>
            )}

            {state.kind === "error" && (
              <div class="h-full flex flex-col items-center justify-center gap-4">
                <div class="w-12 h-12 rounded-full flex items-center justify-center" style={{ background: "rgba(255,72,0,0.15)" }}>
                  <svg class="w-6 h-6" style={{ color: "#FF4800" }} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </div>
                <p class="text-sm text-center px-4">{state.message}</p>
              </div>
            )}
          </main>

          {/* ── Footer ── */}
          <footer class="px-4 py-3" style={{ borderTop: "1px solid #2A2A2A" }}>
            {state.kind === "result" && (
              <div class="flex gap-2">
                <button onClick={handleSaveMd}
                  class="flex-1 py-2.5 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 transition-all duration-200"
                  style={{ border: "1px solid #2A2A2A", color: "#F0EDE8", background: "transparent" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#161616")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" />
                  </svg>
                  Save .md
                </button>
                <button onClick={handleCopy}
                  class="flex-1 py-2.5 px-4 rounded-lg text-sm font-semibold flex items-center justify-center gap-1.5 transition-all duration-200"
                  style={{ border: "1px solid #2A2A2A", color: "#F0EDE8", background: "transparent" }}
                  onMouseEnter={(e) => (e.currentTarget.style.background = "#161616")}
                  onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                  </svg>
                  {copied ? "Copied!" : "Copy"}
                </button>
                <button onClick={reset}
                  class="py-2.5 px-5 rounded-lg text-sm font-bold transition-all duration-200"
                  style={{ background: "#FF4800", color: "#fff" }}
                  onMouseEnter={(e) => ((e.target as HTMLElement).style.background = "#E04200")}
                  onMouseLeave={(e) => ((e.target as HTMLElement).style.background = "#FF4800")}
                >NEW</button>
              </div>
            )}

            {state.kind === "error" && (
              <button onClick={reset}
                class="w-full py-2.5 px-4 rounded-lg text-sm font-semibold transition-all duration-200"
                style={{ background: "#FF4800", color: "#fff" }}
                onMouseEnter={(e) => ((e.target as HTMLElement).style.background = "#E04200")}
                onMouseLeave={(e) => ((e.target as HTMLElement).style.background = "#FF4800")}
              >Try Again</button>
            )}

            {(state.kind === "idle" || state.kind === "converting") && (
              <div class="flex items-center justify-between">
                <p class="text-xs" style={{ color: "#888480" }}>
                  Powered by{" "}
                  <a href="https://mdspin.app" target="_blank" rel="noopener" style={{ color: "#FF4800" }} class="hover:underline">
                    mdspin.app
                  </a>
                </p>

                {/* Sign-in / user avatar */}
                {user ? (
                  <div class="relative">
                    <button
                      onClick={() => setShowUserMenu(!showUserMenu)}
                      class="w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold text-white transition-opacity duration-150"
                      style={{ background: "#FF4800" }}
                      title={user.email}
                    >
                      {userInitial}
                    </button>
                    {showUserMenu && (
                      <div
                        class="absolute bottom-9 right-0 rounded-lg p-3 flex flex-col gap-2 min-w-[160px]"
                        style={{ background: "#1E1E1E", border: "1px solid #2A2A2A", zIndex: 10 }}
                      >
                        <p class="text-[11px] truncate" style={{ color: "#888480" }}>{user.email}</p>
                        <button
                          onClick={handleSignOut}
                          class="text-xs text-left transition-colors duration-150"
                          style={{ color: "#FF4800" }}
                          onMouseEnter={(e) => ((e.target as HTMLElement).style.textDecoration = "underline")}
                          onMouseLeave={(e) => ((e.target as HTMLElement).style.textDecoration = "none")}
                        >
                          Sign out
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <button
                    onClick={() => openAuthView("signin")}
                    title="Sign in"
                    class="transition-colors duration-150"
                    style={{ color: "#888480" }}
                    onMouseEnter={(e) => ((e.currentTarget as HTMLElement).style.color = "#F0EDE8")}
                    onMouseLeave={(e) => ((e.currentTarget as HTMLElement).style.color = "#888480")}
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                      <circle cx="12" cy="7" r="4" />
                    </svg>
                  </button>
                )}
              </div>
            )}
          </footer>
        </>
      )}
    </div>
  );
}
