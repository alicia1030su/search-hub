import { useState } from "react";
import { Download, DatabaseBackup, FileCheck2, ShieldCheck, Upload } from "lucide-react";
import { api, toApiError } from "../lib/api";
import { formatBytes, formatDateTime } from "../lib/format";
import { useAsyncData } from "../lib/hooks";
import { t } from "../lib/i18n";
import type { BackupVerification } from "../lib/types";
import { Alert, Badge, Button, Card, CardContent, CardDescription, CardHeader, CardTitle, Field, Input, PageHeader } from "../components/ui";

interface WritableFileHandle {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort?(): Promise<void>;
}

type SaveFileWindow = Window & {
  showSaveFilePicker?: (options: { suggestedName: string }) => Promise<{ createWritable(): Promise<WritableFileHandle> }>;
};

async function saveResponse(response: Response, filename: string): Promise<boolean> {
  const picker = (window as SaveFileWindow).showSaveFilePicker;
  if (!picker || !response.body) throw new Error(t("backup.streamingRequired"));
  let handle: WritableFileHandle | undefined;
  try {
    handle = await (await picker({ suggestedName: filename })).createWritable();
    const reader = response.body.getReader();
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        await handle.write(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    await handle.close();
    return true;
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") return false;
    try { await handle?.abort?.(); } catch { /* best effort */ }
    throw error;
  }
}

/** Backup center: encrypted downloads and verification, never in-place restore. */
export function BackupPage() {
  const status = useAsyncData((signal) => api.backupStatus(signal), []);
  const [passphrase, setPassphrase] = useState("");
  const [verifyPassphrase, setVerifyPassphrase] = useState("");
  const [verifyPackage, setVerifyPackage] = useState(false);
  const [creating, setCreating] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [verification, setVerification] = useState<BackupVerification | null>(null);

  const createPackage = async (): Promise<void> => {
    setCreating(true);
    setError(null);
    setMessage(null);
    try {
      if (!(window as SaveFileWindow).showSaveFilePicker) throw new Error(t("backup.streamingRequired"));
      const result = await api.downloadBackupPackage(passphrase);
      const saved = await saveResponse(result.response, result.filename);
      setMessage(t(saved ? "backup.packageReady" : "backup.packageCreated"));
      setPassphrase("");
      status.reload();
    } catch (cause) {
      setError(toApiError(cause).message);
    } finally {
      setCreating(false);
    }
  };

  const verifyFile = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    const packageFile = file.name.toLowerCase().endsWith(".shbackup");
    setVerifyPackage(packageFile);
    setVerifying(true);
    setError(null);
    setVerification(null);
    try {
      if (file.size > 64 * 1024 * 1024) throw new Error(t("backup.tooLarge"));
      if (packageFile && Array.from(verifyPassphrase.trim()).length < 12) throw new Error(t("backup.verifyPassphraseRequired"));
      const report = packageFile
        ? await api.verifyBackupPackage(file, verifyPassphrase)
        : await api.verifyDatabaseBackup(file);
      setVerification(report);
      setVerifyPassphrase("");
    } catch (cause) {
      setError(toApiError(cause).message);
    } finally {
      setVerifying(false);
    }
  };

  const readiness = status.data === null
    ? "unknown"
    : status.data.restoreReadiness
      ? "ready"
      : !status.data.latestBackup
        ? "missing"
        : status.data.keyReadiness === "mismatch"
          ? "mismatch"
          : "unverified";
  return (
    <div className="space-y-5">
      <PageHeader title={t("backup.title")} description={t("backup.description")} />

      {error ? <Alert tone="error">{error}</Alert> : null}
      {message ? <Alert tone="success">{message}</Alert> : null}
      {status.error ? <Alert tone="error">{status.error.message}</Alert> : null}

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Card><CardContent className="space-y-1 p-4"><p className="text-xs text-muted-foreground">{t("backup.database")}</p><p className="text-lg font-semibold">{status.data === null ? "—" : formatBytes(status.data.dbBytes)}</p><p className="truncate font-mono text-[11px] text-muted-foreground">{status.data?.schema ?? t("common.unknown")}</p></CardContent></Card>
        <Card><CardContent className="space-y-1 p-4"><p className="text-xs text-muted-foreground">{t("backup.wal")}</p><p className="text-lg font-semibold">{status.data === null ? "—" : formatBytes(status.data.walBytes)}</p><p className="text-xs text-muted-foreground">{t("backup.consistentSnapshot")}</p></CardContent></Card>
        <Card><CardContent className="space-y-1 p-4"><p className="text-xs text-muted-foreground">{t("backup.keySource")}</p><p className="text-lg font-semibold">{status.data?.keySource ?? "—"}</p><p className="text-xs text-muted-foreground">{t("backup.keyNeverShown")}</p></CardContent></Card>
        <Card><CardContent className="space-y-1 p-4"><p className="text-xs text-muted-foreground">{t("backup.readiness")}</p><Badge tone={readiness === "unknown" ? "muted" : readiness === "ready" ? "success" : readiness === "mismatch" ? "destructive" : "warning"}>{readiness === "unknown" ? (status.loading ? t("common.loading") : t("common.unknown")) : readiness}</Badge><p className="text-xs text-muted-foreground">{status.data === null ? (status.loading ? t("common.loading") : t("common.unknown")) : status.data.latestBackup ? formatDateTime(status.data.latestBackup.time) : t("backup.noBackup")}</p></CardContent></Card>
      </div>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2"><ShieldCheck className="size-4" />{t("backup.completeTitle")}</CardTitle><CardDescription>{t("backup.completeDescription")}</CardDescription></div></CardHeader>
          <CardContent className="space-y-4">
            <Field label={t("backup.passphrase")} htmlFor="backup-passphrase" hint={t("backup.passphraseHint")} required>
              <Input id="backup-passphrase" type="password" autoComplete="new-password" value={passphrase} onChange={(event) => setPassphrase(event.target.value)} placeholder={t("backup.passphrasePlaceholder")} />
            </Field>
            <Button loading={creating} disabled={Array.from(passphrase.trim()).length < 12} onClick={() => void createPackage()}><Download aria-hidden />{t("backup.createDownload")}</Button>
            <Alert tone="info">{t("backup.encryptionNote")}</Alert>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2"><DatabaseBackup className="size-4" />{t("backup.legacyTitle")}</CardTitle><CardDescription>{t("backup.legacyDescription")}</CardDescription></div></CardHeader>
          <CardContent className="space-y-4">
            <Button variant="outline" onClick={() => window.location.assign("/api/admin/backup")}><Download aria-hidden />{t("backup.downloadDatabase")}</Button>
            <Alert tone="warning">{t("backup.legacyWarning")}</Alert>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle className="flex items-center gap-2"><FileCheck2 className="size-4" />{t("backup.verifyTitle")}</CardTitle><CardDescription>{t("backup.verifyDescription")}</CardDescription></div></CardHeader>
          <CardContent className="space-y-3">
            {verifyPackage ? (
              <Field label={t("backup.verifyPassphrase")} htmlFor="backup-verify-passphrase" hint={t("backup.passphraseHint")} required>
                <Input id="backup-verify-passphrase" type="password" autoComplete="new-password" value={verifyPassphrase} onChange={(event) => setVerifyPassphrase(event.target.value)} />
              </Field>
            ) : null}
            <label className="flex cursor-pointer items-center justify-center gap-2 rounded-md border border-dashed p-5 text-sm text-muted-foreground hover:bg-accent/40">
              <Upload className="size-4" aria-hidden />
              {verifying ? t("backup.verifying") : t("backup.chooseBackup")}
              <input className="sr-only" type="file" accept=".shbackup,.db,application/vnd.sqlite3,application/octet-stream" disabled={verifying} onChange={(event) => { void verifyFile(event.target.files?.[0]); event.target.value = ""; }} />
            </label>
            {verification ? (
              <dl className="grid grid-cols-2 gap-2 text-xs">
                {([
                  ["formatOk", verification.formatOk],
                  ["structuralOk", verification.structuralOk],
                  ["schemaCompatible", verification.schemaCompatible],
                  ["keyFingerprintMatch", verification.keyFingerprintMatch],
                  ["ciphertextSampleDecryptable", verification.ciphertextSampleDecryptable],
                  ["restoreReadiness", verification.restoreReadiness],
                  ["keyReadiness", verification.keyReadiness],
                  ["sampleCount", verification.sampleCount],
                  ["keyProofValid", verification.keyProofValid],
                ] as const).map(([key, value]) => <div key={key} className="flex items-center justify-between rounded border p-2"><dt>{t(`backup.report.${key}`)}</dt><dd>{value === null || value === undefined ? "—" : String(value)}</dd></div>)}
              </dl>
            ) : null}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><div><CardTitle>{t("backup.restoreTitle")}</CardTitle><CardDescription>{t("backup.restoreDescription")}</CardDescription></div></CardHeader>
          <CardContent className="space-y-3">
            <ol className="list-decimal space-y-2 pl-5 text-sm text-muted-foreground">
              <li>{t("backup.restoreStep1")}</li>
              <li>{t("backup.restoreStep2")}</li>
              <li>{t("backup.restoreStep3")}</li>
            </ol>
            <pre className="overflow-x-auto rounded-md border bg-muted/40 p-3 font-mono text-[11px]">shub backup restore search-hub.shbackup --data-dir /srv/search-hub/restored --passphrase-stdin</pre>
            <Alert tone="warning">{t("backup.noInPlaceRestore")}</Alert>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
