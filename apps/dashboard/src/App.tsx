import type { AccountStatus, DesktopDevice } from "@laryn/shared";
import {
  Activity,
  ArrowUpRight,
  CheckCircle2,
  CircleAlert,
  CreditCard,
  Download,
  Laptop,
  Loader2,
  LogOut,
  MonitorUp,
  RefreshCw,
  ShieldCheck,
  Sparkles,
  WalletCards
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { ApiError, requestJson } from "./api";
import { Alert, AlertDescription, AlertTitle } from "./components/ui/alert";
import { Avatar, AvatarFallback, AvatarImage } from "./components/ui/avatar";
import { Badge } from "./components/ui/badge";
import { Button } from "./components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "./components/ui/card";
import { Progress } from "./components/ui/progress";
import { Separator } from "./components/ui/separator";
import { Skeleton } from "./components/ui/skeleton";
import { cn } from "./lib/utils";
import logoUrl from "../../../logo.svg";

type AuthenticatedAccount = AccountStatus & {
  authenticated: true;
  user: NonNullable<AccountStatus["user"]>;
};

type Notice = {
  tone: "success" | "warning" | "error";
  title: string;
  message?: string;
};

type BusyAction = "sign-in" | "sign-out" | "checkout" | "portal" | "reconcile" | "approve";

const PENDING_DEVICE_CODE_KEY = "laryn.pendingDeviceCode";

export default function App() {
  const [account, setAccount] = useState<AuthenticatedAccount | null>(null);
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busyAction, setBusyAction] = useState<BusyAction | null>(null);
  const [revokingDevices, setRevokingDevices] = useState<Set<string>>(() => new Set());
  const [pendingCode, setPendingCode] = useState(readPendingDeviceCode);

  const loadAccount = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    try {
      const nextAccount = await requestJson<AccountStatus>("/api/account/me");
      if (isAuthenticatedAccount(nextAccount)) {
        setAccount(nextAccount);
      } else {
        setAccount(null);
      }
    } catch (error) {
      setAccount(null);
      if (!(error instanceof ApiError) || error.status !== 401) {
        setNotice({
          tone: "error",
          title: "Could not load account",
          message: errorMessage(error)
        });
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAccount();
  }, [loadAccount]);

  const handleSignIn = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("sign-in");
    setNotice(null);
    try {
      const callbackURL = pendingCode ? `/app?device_code=${encodeURIComponent(pendingCode)}` : "/app";
      const data = await requestJson<{ url?: string }>("/api/auth/sign-in/social", {
        method: "POST",
        body: JSON.stringify({ provider: "google", callbackURL })
      });
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setNotice({
        tone: "warning",
        title: "Google did not return a sign-in URL",
        message: "Try again from this browser tab."
      });
    } catch (error) {
      setNotice({ tone: "error", title: "Sign in failed", message: errorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, pendingCode]);

  const handleSignOut = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("sign-out");
    try {
      await requestJson("/api/auth/sign-out", { method: "POST" });
    } catch {
      // The local UI can reset even if the session is already gone.
    } finally {
      setAccount(null);
      setNotice(null);
      setBusyAction(null);
    }
  }, [busyAction]);

  const handleApproveDevice = useCallback(async () => {
    if (!pendingCode || busyAction) return;
    setBusyAction("approve");
    setNotice(null);
    try {
      await requestJson("/api/device/approve", {
        method: "POST",
        body: JSON.stringify({ userCode: pendingCode })
      });
      window.history.replaceState(null, "", "/app");
      window.sessionStorage.removeItem(PENDING_DEVICE_CODE_KEY);
      setPendingCode("");
      setNotice({
        tone: "success",
        title: "Computer approved",
        message: "Return to the desktop app. It will finish pairing in a few seconds."
      });
      await loadAccount(true);
    } catch (error) {
      setNotice({ tone: "error", title: "Approval failed", message: errorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, loadAccount, pendingCode]);

  const handleCheckout = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("checkout");
    setNotice(null);
    try {
      const data = await requestJson<{ url?: string }>("/api/account/checkout/pro", { method: "POST" });
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setNotice({ tone: "warning", title: "Checkout did not return a URL" });
    } catch (error) {
      setNotice({ tone: "error", title: "Checkout failed", message: errorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction]);

  const handlePortal = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("portal");
    setNotice(null);
    try {
      const data = await requestJson<{ url?: string }>("/api/account/portal", { method: "POST" });
      if (data.url) {
        window.location.href = data.url;
        return;
      }
      setNotice({ tone: "warning", title: "Billing portal did not return a URL" });
    } catch (error) {
      setNotice({ tone: "error", title: "Billing portal failed", message: errorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction]);

  const handleReconcileBilling = useCallback(async () => {
    if (busyAction) return;
    setBusyAction("reconcile");
    setNotice(null);
    try {
      const data = await requestJson<Pick<AccountStatus, "billing">>("/api/account/reconcile/polar", { method: "POST" });
      setNotice({
        tone: data.billing?.proActive ? "success" : "warning",
        title: "Billing refreshed",
        message: data.billing?.proActive ? "Your Pro plan is active." : "No active Pro plan was found."
      });
      await loadAccount(true);
    } catch (error) {
      setNotice({ tone: "error", title: "Billing refresh failed", message: errorMessage(error) });
    } finally {
      setBusyAction(null);
    }
  }, [busyAction, loadAccount]);

  const handleRevokeDevice = useCallback(
    async (id: string) => {
      if (!id || revokingDevices.has(id)) return;
      setRevokingDevices((current) => new Set(current).add(id));
      setAccount((current) => {
        if (!current?.devices) return current;
        return {
          ...current,
          devices: current.devices.filter((device) => device.id !== id)
        };
      });
      try {
        await requestJson(`/api/account/devices/${encodeURIComponent(id)}/revoke`, { method: "POST" });
        await loadAccount(true);
      } catch (error) {
        setNotice({ tone: "error", title: "Sign out failed", message: errorMessage(error) });
        await loadAccount(true);
      } finally {
        setRevokingDevices((current) => {
          const next = new Set(current);
          next.delete(id);
          return next;
        });
      }
    },
    [loadAccount, revokingDevices]
  );

  const subtitle = account
    ? `Welcome back${firstName(account.user.name) ? `, ${firstName(account.user.name)}` : ""}.`
    : "Manage your plan, paired computers, and monthly usage.";

  return (
    <div className="min-h-dvh bg-background text-foreground">
      <DashboardTopbar
        account={account}
        busyAction={busyAction}
        onSignIn={handleSignIn}
        onSignOut={handleSignOut}
      />

      <main className="mx-auto grid w-full max-w-7xl gap-5 px-4 py-5 sm:px-6 lg:px-8 lg:py-8">
        <PageHeader subtitle={subtitle} />

        {pendingCode ? (
          <DeviceApproval
            account={account}
            code={pendingCode}
            busy={busyAction === "approve"}
            onApprove={handleApproveDevice}
          />
        ) : null}

        {notice ? <NoticeBanner notice={notice} onDismiss={() => setNotice(null)} /> : null}

        {loading ? (
          <DashboardSkeleton />
        ) : account ? (
          <AccountDashboard
            account={account}
            busyAction={busyAction}
            revokingDevices={revokingDevices}
            onCheckout={handleCheckout}
            onPortal={handlePortal}
            onReconcileBilling={handleReconcileBilling}
            onRevokeDevice={(id) => void handleRevokeDevice(id)}
          />
        ) : (
          <SignedOutDashboard busy={busyAction === "sign-in"} onSignIn={handleSignIn} />
        )}
      </main>
    </div>
  );
}

function DashboardTopbar({
  account,
  busyAction,
  onSignIn,
  onSignOut
}: {
  account: AuthenticatedAccount | null;
  busyAction: BusyAction | null;
  onSignIn: () => void;
  onSignOut: () => void;
}) {
  return (
    <header className="sticky top-0 z-20 border-b border-border bg-background/88 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-4 px-4 sm:px-6 lg:px-8">
        <a className="flex min-w-0 items-center gap-3" href="/app" aria-label="Laryn dashboard">
          <img className="size-8 shrink-0 rounded-lg shadow-[0_0_26px_hsl(var(--primary)/.22)]" src={logoUrl} alt="" aria-hidden="true" />
          <span className="grid leading-tight">
            <strong className="text-sm font-semibold">Laryn</strong>
            <span className="text-xs text-muted-foreground">Account</span>
          </span>
        </a>

        <nav className="hidden items-center rounded-lg border border-border bg-muted/40 p-1 sm:flex" aria-label="Primary">
          <a className="rounded-md bg-background px-3 py-1.5 text-sm font-medium text-foreground" href="/app">
            Account
          </a>
          <a className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground" href="/pricing">
            Pricing
          </a>
          <a className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:text-foreground" href="/download">
            Download
          </a>
        </nav>

        <div className="flex min-w-0 items-center gap-2">
          {account ? (
            <>
              <div className="hidden min-w-0 items-center gap-2 rounded-lg border border-border bg-card px-2 py-1 sm:flex">
                <UserAvatar account={account} />
                <div className="grid min-w-0 leading-tight">
                  <strong className="truncate text-sm font-medium">{account.user.name || account.user.email}</strong>
                  <span className="truncate text-xs text-muted-foreground">{account.user.email}</span>
                </div>
              </div>
              <Button variant="ghost" size="sm" disabled={busyAction === "sign-out"} onClick={onSignOut}>
                {busyAction === "sign-out" ? <Loader2 className="animate-spin" /> : <LogOut />}
                Sign out
              </Button>
            </>
          ) : (
            <Button size="sm" disabled={busyAction === "sign-in"} onClick={onSignIn}>
              {busyAction === "sign-in" ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
              Sign in
            </Button>
          )}
        </div>
      </div>
    </header>
  );
}

function PageHeader({ subtitle }: { subtitle: string }) {
  return (
    <section className="grid gap-2 pt-2">
      <div className="flex items-center gap-2 text-sm font-medium text-primary">
        <span className="size-2 rounded-sm bg-primary" aria-hidden="true" />
        Account control
      </div>
      <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_auto] md:items-end">
        <div className="grid gap-2">
          <h1 className="text-4xl font-semibold leading-none sm:text-5xl">Dashboard</h1>
          <p className="max-w-2xl text-base leading-7 text-muted-foreground">{subtitle}</p>
        </div>
        <Button variant="outline" asChild>
          <a href="/download">
            <Download />
            Download app
          </a>
        </Button>
      </div>
    </section>
  );
}

function DeviceApproval({
  account,
  code,
  busy,
  onApprove
}: {
  account: AuthenticatedAccount | null;
  code: string;
  busy: boolean;
  onApprove: () => void;
}) {
  return (
    <Alert className="border-primary/35 bg-primary/10">
      <MonitorUp className="mt-0.5 size-5 text-primary" />
      <div>
        <AlertTitle>{account ? "Approve this computer" : "Sign in to add this computer"}</AlertTitle>
        <AlertDescription>
          {account ? "Link this desktop to your account with code " : "After sign-in, approve desktop code "}
          <code className="rounded-md bg-background px-1.5 py-0.5 font-mono text-foreground">{code}</code>.
        </AlertDescription>
      </div>
      {account ? (
        <Button size="sm" disabled={busy} onClick={onApprove}>
          {busy ? <Loader2 className="animate-spin" /> : <CheckCircle2 />}
          Approve
        </Button>
      ) : null}
    </Alert>
  );
}

function NoticeBanner({ notice, onDismiss }: { notice: Notice; onDismiss: () => void }) {
  const icon =
    notice.tone === "success" ? (
      <CheckCircle2 className="mt-0.5 size-5 text-success" />
    ) : (
      <CircleAlert className={cn("mt-0.5 size-5", notice.tone === "warning" ? "text-warning" : "text-destructive")} />
    );

  return (
    <Alert
      className={cn(
        notice.tone === "success" && "border-success/30 bg-success/10",
        notice.tone === "warning" && "border-warning/35 bg-warning/10",
        notice.tone === "error" && "border-destructive/35 bg-destructive/10"
      )}
    >
      {icon}
      <div>
        <AlertTitle>{notice.title}</AlertTitle>
        {notice.message ? <AlertDescription>{notice.message}</AlertDescription> : null}
      </div>
      <Button variant="ghost" size="sm" onClick={onDismiss}>
        Dismiss
      </Button>
    </Alert>
  );
}

function SignedOutDashboard({ busy, onSignIn }: { busy: boolean; onSignIn: () => void }) {
  return (
    <section className="grid gap-5 rounded-lg border border-border bg-card p-5 shadow-sm md:grid-cols-[minmax(0,1fr)_320px] md:p-8">
      <div className="grid content-center gap-5">
        <Badge variant="secondary" className="w-fit">
          <ShieldCheck className="size-3.5" />
          Google account required
        </Badge>
        <div className="grid max-w-2xl gap-3">
          <h2 className="text-3xl font-semibold leading-tight sm:text-4xl">Sign in to manage Laryn Pro.</h2>
          <p className="text-base leading-7 text-muted-foreground">
            Pair computers, check monthly usage, start Pro, or open billing without leaving this Worker-hosted account page.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Button size="lg" disabled={busy} onClick={onSignIn}>
            {busy ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Sign in with Google
          </Button>
          <Button variant="outline" size="lg" asChild>
            <a href="/download">
              <Download />
              Download app
            </a>
          </Button>
        </div>
      </div>
      <div className="grid content-between gap-5 rounded-lg border border-border bg-background p-5">
        <div className="grid gap-3">
          <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
            <Sparkles className="size-4 text-primary" />
            Included with Pro
          </div>
          <div className="grid gap-3 text-sm text-muted-foreground">
            <FeatureRow>Dictation into any focused desktop app</FeatureRow>
            <FeatureRow>Usage credits tracked against your plan</FeatureRow>
            <FeatureRow>Unlimited paired desktop installs</FeatureRow>
          </div>
        </div>
        <Button variant="ghost" asChild className="justify-start px-0">
          <a href="/pricing">
            See pricing
            <ArrowUpRight />
          </a>
        </Button>
      </div>
    </section>
  );
}

function AccountDashboard({
  account,
  busyAction,
  revokingDevices,
  onCheckout,
  onPortal,
  onReconcileBilling,
  onRevokeDevice
}: {
  account: AuthenticatedAccount;
  busyAction: BusyAction | null;
  revokingDevices: Set<string>;
  onCheckout: () => void;
  onPortal: () => void;
  onReconcileBilling: () => void;
  onRevokeDevice: (id: string) => void;
}) {
  const billing = account.billing;
  const devices = useMemo(() => (account.devices ?? []).filter((device) => !device.revokedAt), [account.devices]);
  const usage = account.usage ?? { transcriptionCount: 0, audioDurationMs: 0 };
  const proActive = Boolean(billing?.proActive);
  const credits = billing?.usageCredits;

  return (
    <div className="grid gap-5">
      <PlanPanel
        proActive={proActive}
        subscriptionStatus={billing?.subscriptionStatus}
        busyAction={busyAction}
        onCheckout={onCheckout}
        onPortal={onPortal}
        onReconcileBilling={onReconcileBilling}
      />

      <section className="grid gap-5 lg:grid-cols-12">
        <UsageCard credits={credits} className="lg:col-span-7" />
        <ActivityCard usage={usage} deviceCount={devices.length} className="lg:col-span-5" />
        <AccountCard account={account} className="lg:col-span-4" />
        <DevicesCard
          devices={devices}
          revokingDevices={revokingDevices}
          onRevokeDevice={onRevokeDevice}
          className="lg:col-span-8"
        />
      </section>
    </div>
  );
}

function PlanPanel({
  proActive,
  subscriptionStatus,
  busyAction,
  onCheckout,
  onPortal,
  onReconcileBilling
}: {
  proActive: boolean;
  subscriptionStatus?: string;
  busyAction: BusyAction | null;
  onCheckout: () => void;
  onPortal: () => void;
  onReconcileBilling: () => void;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-[linear-gradient(120deg,hsl(var(--card)),hsl(var(--card-elevated)))] shadow-sm">
      <div className="grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_auto] md:items-center md:p-6">
        <div className="grid gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Badge variant={proActive ? "success" : "warning"}>
              <span className="size-1.5 rounded-sm bg-current" aria-hidden="true" />
              {proActive ? "Pro active" : "Pro required"}
            </Badge>
            <span className="text-sm font-medium text-muted-foreground">Laryn Pro</span>
          </div>
          <div className="grid gap-2">
            <h2 className="text-2xl font-semibold leading-tight sm:text-3xl">
              {proActive ? "Ready for production dictation." : "Start Pro to enable desktop transcription."}
            </h2>
            <p className="max-w-3xl text-sm leading-6 text-muted-foreground">
              {proActive
                ? `$5 per month. Subscription status: ${formatPlanStatus(subscriptionStatus, proActive)}.`
                : "The desktop app can pair with this account, but transcription requires an active Pro plan."}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap gap-2 md:justify-end">
          <Button disabled={busyAction === "checkout"} onClick={onCheckout}>
            {busyAction === "checkout" ? <Loader2 className="animate-spin" /> : <CreditCard />}
            {proActive ? "Manage plan" : "Get Pro - $5/mo"}
          </Button>
          <Button variant="secondary" disabled={busyAction === "portal"} onClick={onPortal}>
            {busyAction === "portal" ? <Loader2 className="animate-spin" /> : <WalletCards />}
            Billing
          </Button>
          <Button variant="ghost" disabled={busyAction === "reconcile"} onClick={onReconcileBilling}>
            {busyAction === "reconcile" ? <Loader2 className="animate-spin" /> : <RefreshCw />}
            Refresh
          </Button>
        </div>
      </div>
    </section>
  );
}

function UsageCard({
  credits,
  className
}: {
  credits?: NonNullable<NonNullable<AccountStatus["billing"]>["usageCredits"]>;
  className?: string;
}) {
  const includedCents = credits?.includedCents ?? 300;
  const usedCents = credits?.consumedCents ?? 0;
  const remainingCents = credits?.remainingCents ?? Math.max(0, includedCents - usedCents);
  const overageCents = credits?.overageCents ?? 0;
  const percent = creditUsagePercent(credits);

  return (
    <Card className={className}>
      <CardHeader>
        <div className="grid gap-1">
          <CardDescription>Dictation this month</CardDescription>
          <CardTitle>Included usage</CardTitle>
        </div>
        <Badge variant="secondary">{dollars(includedCents)} included</Badge>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-3">
          <div className="flex items-end justify-between gap-4">
            <div className="grid gap-1">
              <span className="num text-4xl font-semibold">{dollars(usedCents)}</span>
              <span className="text-sm text-muted-foreground">used of {dollars(includedCents)}</span>
            </div>
            <span className="num text-sm text-muted-foreground">{Math.round(percent)}% used</span>
          </div>
          <Progress
            value={percent}
            indicatorClassName={overageCents > 0 ? "bg-warning" : "bg-primary"}
          />
          <div className="flex justify-between gap-4 text-sm text-muted-foreground">
            <span>{dollars(remainingCents)} left</span>
            <span>{overageCents > 0 ? `${dollars(overageCents)} over` : "No overage"}</span>
          </div>
        </div>
        {overageCents > 0 ? (
          <div className="rounded-lg border border-warning/35 bg-warning/10 p-3 text-sm text-warning">
            Usage past the included credit is billed through Polar at cost this month.
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

function ActivityCard({
  usage,
  deviceCount,
  className
}: {
  usage: NonNullable<AccountStatus["usage"]>;
  deviceCount: number;
  className?: string;
}) {
  const minutes = Math.round((usage.audioDurationMs || 0) / 60000);

  return (
    <Card className={className}>
      <CardHeader>
        <div className="grid gap-1">
          <CardDescription>Activity</CardDescription>
          <CardTitle>All-time totals</CardTitle>
        </div>
        <Activity className="size-5 text-primary" />
      </CardHeader>
      <CardContent>
        <dl className="grid gap-1 overflow-hidden rounded-lg border border-border">
          <MetricRow label="Transcripts" value={usage.transcriptionCount || 0} />
          <MetricRow label="Minutes" value={minutes} />
          <MetricRow label="Computers" value={deviceCount} />
        </dl>
      </CardContent>
    </Card>
  );
}

function AccountCard({
  account,
  className
}: {
  account: AuthenticatedAccount;
  className?: string;
}) {
  const billing = account.billing;

  return (
    <Card className={className}>
      <CardHeader className="items-center">
        <div className="grid min-w-0 gap-1">
          <CardDescription>Signed in</CardDescription>
          <CardTitle className="truncate">{account.user.name || account.user.email}</CardTitle>
        </div>
        <UserAvatar account={account} />
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 text-sm">
          <DefinitionRow label="Email" value={account.user.email || "unknown"} />
          <DefinitionRow label="Plan" value={formatPlanStatus(billing?.subscriptionStatus, billing?.proActive)} />
          <DefinitionRow label="Included" value={`${dollars(billing?.usageCredits?.includedCents ?? 300)} / month`} />
        </dl>
      </CardContent>
    </Card>
  );
}

function DevicesCard({
  devices,
  revokingDevices,
  onRevokeDevice,
  className
}: {
  devices: DesktopDevice[];
  revokingDevices: Set<string>;
  onRevokeDevice: (id: string) => void;
  className?: string;
}) {
  return (
    <Card className={className}>
      <CardHeader>
        <div className="grid gap-1">
          <CardDescription>Your computers</CardDescription>
          <CardTitle>{devices.length} signed in</CardTitle>
        </div>
        <Button variant="ghost" size="sm" asChild>
          <a href="/download">
            Add another
            <ArrowUpRight />
          </a>
        </Button>
      </CardHeader>
      <CardContent>
        {devices.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border p-5 text-sm leading-6 text-muted-foreground">
            Install Laryn, open Settings, and sign in with the same Google account.
          </div>
        ) : (
          <ul className="grid gap-2" role="list">
            {devices.map((device) => {
              const revoking = revokingDevices.has(device.id);
              return (
                <li
                  key={device.id}
                  className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 rounded-lg border border-border bg-background px-3 py-3"
                >
                  <span className="grid size-9 place-items-center rounded-md bg-primary/10 text-primary">
                    <Laptop className="size-4" />
                  </span>
                  <div className="grid min-w-0 gap-1">
                    <strong className="truncate text-sm font-medium">{device.deviceName}</strong>
                    <span className="truncate text-xs text-muted-foreground">
                      {device.lastSeenAt ? `Last seen ${formatDate(device.lastSeenAt)}` : `Paired ${formatDate(device.createdAt)}`}
                    </span>
                  </div>
                  <Button variant="ghost" size="sm" disabled={revoking} onClick={() => onRevokeDevice(device.id)}>
                    {revoking ? <Loader2 className="animate-spin" /> : <LogOut />}
                    <span className="hidden sm:inline">Sign out</span>
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function DashboardSkeleton() {
  return (
    <div className="grid gap-5">
      <Skeleton className="h-40" />
      <section className="grid gap-5 lg:grid-cols-12">
        <Skeleton className="h-64 lg:col-span-7" />
        <Skeleton className="h-64 lg:col-span-5" />
        <Skeleton className="h-56 lg:col-span-4" />
        <Skeleton className="h-56 lg:col-span-8" />
      </section>
    </div>
  );
}

function UserAvatar({ account }: { account: AuthenticatedAccount }) {
  const label = account.user.name || account.user.email || "Laryn";
  const initial = label.trim().charAt(0).toUpperCase() || "L";

  return (
    <Avatar>
      {account.user.image ? <AvatarImage src={account.user.image} alt={label} referrerPolicy="no-referrer" /> : null}
      <AvatarFallback>{initial}</AvatarFallback>
    </Avatar>
  );
}

function FeatureRow({ children }: { children: ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_1fr] items-start gap-2">
      <CheckCircle2 className="mt-0.5 size-4 text-primary" />
      <span>{children}</span>
    </div>
  );
}

function MetricRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border bg-background px-4 py-3 last:border-b-0">
      <dt className="flex items-center gap-2 text-sm text-muted-foreground">
        <span className="size-1.5 rounded-sm bg-primary" aria-hidden="true" />
        {label}
      </dt>
      <dd className="num text-2xl font-semibold">{value}</dd>
    </div>
  );
}

function DefinitionRow({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-1 truncate font-medium" title={value}>
        {value}
      </dd>
      <Separator className="mt-3 last:hidden" />
    </div>
  );
}

function readPendingDeviceCode() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("device_code") || window.sessionStorage.getItem(PENDING_DEVICE_CODE_KEY) || "";
  if (code) window.sessionStorage.setItem(PENDING_DEVICE_CODE_KEY, code);
  return code;
}

function isAuthenticatedAccount(account: AccountStatus): account is AuthenticatedAccount {
  return Boolean(account.authenticated && account.user);
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function firstName(name?: string) {
  return name?.trim().split(/\s+/)[0] || "";
}

function dollars(cents: number) {
  return currencyFormatter.format(Math.max(0, cents) / 100);
}

function formatDate(value?: string) {
  if (!value) return "unknown";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "unknown";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function formatPlanStatus(status?: string, fallbackActive?: boolean) {
  if (status === "active") return "Active";
  if (status === "trialing") return "Trial";
  if (status === "past_due") return "Past due";
  if (status === "canceled" || status === "cancelled") return "Canceled";
  if (status === "revoked") return "Revoked";
  if (status === "inactive") return "Inactive";
  if (status && status !== "unknown") {
    return status.replace(/_/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }
  return fallbackActive ? "Active" : "Free";
}

function creditUsagePercent(credits?: NonNullable<NonNullable<AccountStatus["billing"]>["usageCredits"]>) {
  const consumed = Number(credits?.consumedUnits || 0);
  const credited = Number(credits?.creditedUnits || credits?.includedUnits || 0);
  if (!credited) return 0;
  return Math.min(100, Math.max(0, (consumed / credited) * 100));
}

const currencyFormatter = new Intl.NumberFormat(undefined, {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2
});
