import { useEffect, useState, type Dispatch, type FormEvent, type ReactNode, type SetStateAction } from "react";
import { ArrowLeft, ChevronRight, Copy, KeyRound, Loader2, LogOut } from "lucide-react";
import { toast } from "sonner";
import { api } from "../api";
import { announceUnauthorized, authClient } from "../auth-client";
import { relativeTime } from "../lib/time";
import { uploadCurl } from "../lib/upload-curl";
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

// Keys are managed through the API key plugin's own routes (/api/auth/api-key/*), by Better Auth's client.
type PluginKey = { id: string; name: string | null; start: string | null; enabled: boolean; createdAt: Date | string; lastRequest: Date | string | null };
const keyView = (k: PluginKey): ApiKey => ({
  id: k.id,
  name: k.name ?? "",
  prefix: k.start ?? "",
  createdAt: new Date(k.createdAt).toISOString(),
  lastUsedAt: k.lastRequest ? new Date(k.lastRequest).toISOString() : null,
  status: k.enabled ? "active" : "revoked",
});
/** The client's `{ data, error }` answer as a value, or an Error with the server's message. */
async function unwrap<T>(answer: Promise<{ data: T | null; error: { message?: string; status: number } | null }>) {
  const { data, error } = await answer;
  if (error?.status === 401) announceUnauthorized();
  if (error || !data) throw new Error(error?.message || "Something went wrong.");
  return data;
}
const listKeys = async () =>
  (await unwrap(authClient.apiKey.list())).apiKeys.map(keyView).sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

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
  // Shared: the key list manages the keys and Usage names the same keys, so its rows can tell them apart.
  const [keys, setKeys] = useState<ApiKey[] | null>(null);
  const [keysError, setKeysError] = useState("");
  useEffect(() => {
    let live = true;
    api<Usage>("/usage/summary")
      .then((r) => live && setUsage(r))
      .catch((e: Error) => live && setUsageError(e.message));
    listKeys()
      .then((r) => live && setKeys(r))
      .catch((e: Error) => live && setKeysError(e.message));
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
        <UsageSection usage={usage} error={usageError} keys={keys} />
        <ApiKeys keys={keys} setKeys={setKeys} loadError={keysError} monthly={usage && Object.fromEntries(usage.month.apiKeys.map((k) => [k.id, k.links]))} />
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

/** `keys`: the owner's API keys (null while loading), to show the start of a key's secret and tell apart keys that share a name. */
function UsageSection({ usage, error, keys }: { usage: Usage | null; error: string; keys: ApiKey[] | null }) {
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
              {usage.month.apiKeys.map((key) => {
                const listed = keys?.find((k) => k.id === key.id);
                return (
                  <li key={key.id} className="flex items-center justify-between gap-3">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="truncate">API key: {key.name}</span>
                      {listed && <code className="font-mono text-xs">{listed.prefix}…</code>}
                      {key.status !== "active" && (
                        <Badge variant="outline" className="text-muted-foreground">
                          {key.status === "revoked" ? "Revoked" : "Deleted"}
                        </Badge>
                      )}
                    </span>
                    <span className="tabular-nums">{key.links}</span>
                  </li>
                );
              })}
            </ul>
          </div>
        </>
      )}
    </Section>
  );
}

/**
 * `keys` and `setKeys`: the list, owned by the page (null while loading). `monthly`: this month's new
 * Links per key id (null while loading); keys that added none are absent.
 */
function ApiKeys({
  keys,
  setKeys,
  loadError,
  monthly,
}: {
  keys: ApiKey[] | null;
  setKeys: Dispatch<SetStateAction<ApiKey[] | null>>;
  loadError: string;
  monthly: Record<string, number> | null;
}) {
  const [name, setName] = useState("");
  const [creating, setCreating] = useState(false);
  // The full secret lives only in this state: it is gone once dismissed or the page is left.
  const [created, setCreated] = useState<{ name: string; secret: string } | null>(null);
  const [createError, setCreateError] = useState("");
  const [revoking, setRevoking] = useState<ApiKey | null>(null);
  const [deleting, setDeleting] = useState<ApiKey | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setCreating(true);
    setCreateError("");
    try {
      const r = await unwrap(authClient.apiKey.create({ name: name.trim() }));
      setKeys((list) => [keyView(r), ...(list ?? [])]);
      setCreated({ name: r.name ?? "", secret: r.key });
      setName("");
    } catch (error) {
      setCreateError((error as Error).message);
    } finally {
      setCreating(false);
    }
  };

  const setEnabled = async (key: ApiKey, enabled: boolean) => {
    try {
      const r = await unwrap(authClient.apiKey.update({ keyId: key.id, enabled }));
      setKeys((list) => list?.map((k) => (k.id === key.id ? keyView(r) : k)) ?? null);
      toast.success(`“${key.name}” ${enabled ? "enabled" : "revoked"}`);
    } catch (error) {
      toast.error((error as Error).message);
    }
    setRevoking(null);
  };

  const remove = async (key: ApiKey) => {
    try {
      await unwrap(authClient.apiKey.delete({ keyId: key.id }));
      setKeys((list) => list?.filter((k) => k.id !== key.id) ?? null);
      toast.success(`“${key.name}” deleted`);
    } catch (error) {
      toast.error((error as Error).message);
    }
    setDeleting(null);
  };

  const active = keys?.filter((k) => k.status === "active") ?? [];
  const revoked = keys?.filter((k) => k.status === "revoked") ?? [];

  const details = (key: ApiKey) => (
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
  );

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
          <p className="text-sm">Copy the key for “{created.name}” now. It will not be shown again.</p>
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
          <p className="text-sm text-muted-foreground">Try it from a terminal:</p>
          <div className="flex items-start gap-2">
            <pre className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-background px-2 py-1.5 font-mono text-xs" aria-label="curl example">
              <code>{uploadCurl(window.location.origin, created.secret)}</code>
            </pre>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void navigator.clipboard.writeText(uploadCurl(window.location.origin, created.secret)).then(
                  () => toast("curl example copied"),
                  () => toast.error("Could not copy. Select the example and copy it."),
                );
              }}
            >
              <Copy />
              Copy curl
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
        <>
          {active.length ? (
            <ul aria-label="API keys" className="divide-y">
              {active.map((key) => (
                <li key={key.id} className="flex items-center gap-3 p-4">
                  {details(key)}
                  <Button variant="ghost" size="sm" onClick={() => setRevoking(key)}>
                    Revoke
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => setDeleting(key)}>
                    Delete
                  </Button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="p-4 text-sm text-muted-foreground">No active API keys.</p>
          )}
          {revoked.length > 0 && (
            <details className="group border-t">
              <summary className="flex cursor-pointer list-none items-center gap-2 p-4 text-sm font-medium [&::-webkit-details-marker]:hidden">
                <ChevronRight className="size-4 group-open:rotate-90" />
                Revoked keys ({revoked.length})
              </summary>
              <ul aria-label="Revoked API keys" className="max-h-72 divide-y overflow-y-auto border-t">
                {revoked.map((key) => (
                  <li key={key.id} className="flex items-center gap-3 p-4">
                    {details(key)}
                    <Button variant="ghost" size="sm" onClick={() => void setEnabled(key, true)}>
                      Enable
                    </Button>
                    <Button variant="ghost" size="sm" onClick={() => setDeleting(key)}>
                      Delete
                    </Button>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      <AlertDialog open={!!revoking} onOpenChange={(o) => !o && setRevoking(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke “{revoking?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Anything using this key stops working immediately. The key moves to Revoked keys, where you can enable or delete it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={() => revoking && void setEnabled(revoking, false)}>Revoke</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={!!deleting} onOpenChange={(o) => !o && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{deleting?.name}”?</AlertDialogTitle>
            <AlertDialogDescription>
              The key is removed for good and anything using it stops working. Links it already added stay in your library and in Usage, marked as deleted.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && void remove(deleting)}>
              Delete
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Section>
  );
}
