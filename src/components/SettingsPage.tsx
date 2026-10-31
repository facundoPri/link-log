import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { ArrowLeft, Copy, KeyRound, Loader2, LogOut, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { relativeTime } from "../lib/time";
import type { ApiKey, QuotaUsage, Usage } from "../types";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

const day = new Intl.DateTimeFormat("en", { dateStyle: "medium" });

function Section({ title, description, children }: { title: string; description?: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="flex flex-col gap-3">
      <div>
        <h2 className="text-sm font-semibold">{title}</h2>
        {description && <p className="text-xs text-muted-foreground">{description}</p>}
      </div>
      <div className="rounded-lg border bg-card">{children}</div>
    </section>
  );
}

/** Settings: the account basics, usage and the owner's API keys. */
export function SettingsPage({ account, onSignOut, onBack }: { account: { email: string }; onSignOut: () => void; onBack: () => void }) {
  const [usage, setUsage] = useState<Usage | null>(null);
  const [usageError, setUsageError] = useState("");
  useEffect(() => {
    let live = true;
    api<Usage>("/usage/summary")
      .then((r) => live && setUsage(r))
      .catch((e: Error) => live && setUsageError(e.message));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="min-h-dvh bg-background">
      <div className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-6 md:py-10">
        <header className="flex items-center gap-2">
          <Button variant="ghost" size="icon-sm" aria-label="Back to library" onClick={onBack}>
            <ArrowLeft />
          </Button>
          <h1 className="text-lg font-semibold">Settings</h1>
        </header>
        <Section title="Account">
          <div className="flex items-center justify-between gap-3 p-4">
            <div className="min-w-0">
              <div className="text-xs text-muted-foreground">Email</div>
              <div className="truncate text-sm">{account.email}</div>
            </div>
            <Button variant="outline" onClick={onSignOut}>
              <LogOut />
              Sign out
            </Button>
          </div>
        </Section>
        <UsageSection usage={usage} error={usageError} />
        <ApiKeys monthly={usage && Object.fromEntries(usage.month.apiKeys.map((k) => [k.id, k.links]))} />
      </div>
    </div>
  );
}

const monthName = new Intl.DateTimeFormat("en", { month: "long", year: "numeric", timeZone: "UTC" });
const windowUnit = (seconds: number) => (seconds === 3600 ? "hour" : seconds === 60 ? "minute" : `${seconds} s`);

function QuotaRow({ label, quota }: { label: string; quota: QuotaUsage }) {
  return (
    <li className="flex items-baseline justify-between gap-3 p-4">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-right text-sm tabular-nums">
        {quota.used} / {quota.max} this {windowUnit(quota.windowSeconds)}
        <span className="block text-xs text-muted-foreground">resets {relativeTime(quota.resetsAt)}</span>
      </span>
    </li>
  );
}

function UsageSection({ usage, error }: { usage: Usage | null; error: string }) {
  return (
    <Section title="Usage" description="Your current limits and the new Links you added this month. Duplicates do not count.">
      {error ? (
        <p className="p-4 text-sm text-destructive">{error}</p>
      ) : !usage ? (
        <p className="p-4 text-sm text-muted-foreground" aria-busy="true">Loading…</p>
      ) : (
        <>
          <ul aria-label="Limits" className="divide-y">
            <QuotaRow label="Links" quota={usage.quotas.links} />
            <QuotaRow label="Jobs" quota={usage.quotas.jobs} />
          </ul>
          <div className="border-t p-4">
            <div className="flex items-baseline justify-between gap-3">
              <h3 className="text-sm font-medium">New Links in {monthName.format(new Date(usage.month.start))}</h3>
              <span className="text-sm tabular-nums">{usage.month.links}</span>
            </div>
            <ul aria-label="New Links by source" className="mt-2 flex flex-col gap-1 text-sm text-muted-foreground">
              <li className="flex justify-between gap-3">
                <span>Web</span>
                <span className="tabular-nums">{usage.month.web}</span>
              </li>
              {usage.month.apiKeys.map((key) => (
                <li key={key.id} className="flex justify-between gap-3">
                  <span className="truncate">API key: {key.name}</span>
                  <span className="tabular-nums">{key.links}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      )}
    </Section>
  );
}

/** `monthly`: this month's new Links per key id (null while loading); keys that added none are absent. */
function ApiKeys({ monthly }: { monthly: Record<string, number> | null }) {
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  // The full secret lives only in this state: it is gone once dismissed or the page is left.
  const [created, setCreated] = useState<{ name: string; secret: string; replaced: boolean } | null>(null);
  const [createError, setCreateError] = useState("");
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [regenerating, setRegenerating] = useState<ApiKey | null>(null);

  useEffect(() => {
    let live = true;
    api<{ apiKeys: ApiKey[] }>("/api-keys")
      .then((r) => live && setKeys(r.apiKeys))
      .catch((e: Error) => live && setLoadError(e.message));
    return () => {
      live = false;
    };
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError("");
    try {
      const r = await api<{ apiKey: ApiKey; secret: string }>("/api-keys", "POST", { name });
      setKeys((list) => [r.apiKey, ...(list ?? [])]);
      setCreated({ name: r.apiKey.name, secret: r.secret, replaced: false });
      setName("");
    } catch (error) {
      setCreateError((error as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const revoke = async (key: ApiKey) => {
    try {
      const r = await api<{ apiKey: ApiKey }>(`/api-keys/${key.id}/revoke`, "POST", {});
      setKeys((list) => list?.map((k) => (k.id === key.id ? r.apiKey : k)) ?? null);
      toast.success(`“${key.name}” revoked`);
    } catch (error) {
      toast.error((error as Error).message);
    }
    setRevoking(null);
  };

  // The new key is created before the old one is revoked, so a failure leaves the old key working.
  const regenerate = async (key: ApiKey) => {
    try {
      const r = await api<{ apiKey: ApiKey; secret: string }>(`/api-keys/${key.id}/regenerate`, "POST", {});
      setKeys((list) => [r.apiKey, ...(list ?? []).map((k) => (k.id === key.id ? { ...k, status: "revoked" as const } : k))]);
      setCreated({ name: r.apiKey.name, secret: r.secret, replaced: true });
    } catch (error) {
      toast.error((error as Error).message);
    }
    setRegenerating(null);
  };

  return (
    <Section title="API keys" description="Keys only submit URLs to your library. They cannot read it.">
      <form onSubmit={create} className="flex items-end gap-2 border-b p-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <Label htmlFor="api-key-name">Name</Label>
          <Input id="api-key-name" value={name} maxLength={32} placeholder="e.g. Shortcuts" onChange={(e) => setName(e.target.value)} />
        </div>
        <Button type="submit" disabled={creating || !name.trim()}>
          {creating ? <Loader2 className="animate-spin" /> : <KeyRound />}
          Create key
        </Button>
      </form>
      {createError && (
        <p role="alert" className="border-b p-4 text-sm text-destructive">
          {createError}
        </p>
      )}
      {created && (
        <div role="status" className="flex flex-col gap-2 border-b bg-muted/40 p-4">
          <p className="text-sm">
            {created.replaced ? `Copy the new key for “${created.name}” now. The old key no longer works.` : `Copy the key for “${created.name}” now.`} It will not be shown again.
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-md border bg-background px-2 py-1.5 font-mono text-xs" aria-label="New API key">
              {created.secret}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(created.secret).then(
                  () => toast("API key copied"),
                  () => toast.error("Could not copy. Select the key and copy it."),
                );
              }}
            >
              <Copy />
              Copy
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setCreated(null)}>
              Done
            </Button>
          </div>
        </div>
      )}
      {loadError ? (
        <p className="p-4 text-sm text-destructive">{loadError}</p>
      ) : !keys ? (
        <p className="p-4 text-sm text-muted-foreground" aria-busy="true">Loading…</p>
      ) : !keys.length ? (
        <p className="p-4 text-sm text-muted-foreground">No API keys yet.</p>
      ) : (
        <ul aria-label="API keys" className="divide-y">
          {keys.map((key) => (
            <li key={key.id} className="flex items-center gap-3 p-4">
              <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                <div className="flex items-center gap-2">
                  <span className="truncate text-sm font-medium">{key.name}</span>
                  <Badge variant={key.status === "active" ? "secondary" : "outline"} className={key.status === "revoked" ? "text-muted-foreground" : undefined}>
                    {key.status === "active" ? "Active" : "Revoked"}
                  </Badge>
                </div>
                <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground">
                  <code className="font-mono">{key.prefix}…</code>
                  <span>Created {day.format(new Date(key.createdAt))}</span>
                  <span>{key.lastUsedAt ? `Last used ${relativeTime(key.lastUsedAt)}` : "Never used"}</span>
                  {monthly && <span>{monthly[key.id] ?? 0} {(monthly[key.id] ?? 0) === 1 ? "link" : "links"} this month</span>}
                </div>
              </div>
              {key.status === "active" && (
                <>
                  <Button variant="ghost" size="sm" onClick={() => setRegenerating(key)}>
                    <RefreshCw />
                    Regenerate
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(key)}>
                    Revoke
                  </Button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      <AlertDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke “{revoking?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Anything using this key stops working immediately. The key stays listed as revoked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => revoking && void revoke(revoking)}>Revoke</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!regenerating} onOpenChange={(o) => !o && setRegenerating(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Regenerate “{regenerating?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Linklog creates a new key with the same name and shows its secret once. The current key stops working
              immediately and stays listed as revoked.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => regenerating && void regenerate(regenerating)}>Regenerate</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}
