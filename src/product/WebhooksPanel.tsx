import { useEffect, useState } from 'react';
import { Send, Webhook } from 'lucide-react';
import { api, formatDate, timeAgo, useApi } from './api';
import { Badge, Button, Card, CopyButton, EmptyState, Field, Input, Modal, Mono, Notice, Spinner, Table, Td, Th, cx, useToast } from './ui';
import { can, type Role } from './types';

interface WebhookState {
  configured: boolean;
  url?: string;
  events?: string[];
  createdAt?: string;
  updatedAt?: string;
  availableEvents: string[];
}

interface WebhookDelivery {
  id: string;
  eventType: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  deliveredAt: string | null;
}

/** The workspace's outbound event webhook: endpoint, signing secret, subscriptions and deliveries. Owner-managed. */
export function WebhooksPanel({ workspace }: { workspace: { id: string; role: Role } }) {
  const toast = useToast();
  const owner = can(workspace.role, 'manageWorkspace');
  const hook = useApi<WebhookState>(owner ? `/workspaces/${workspace.id}/webhook` : null);
  const deliveries = useApi<WebhookDelivery[]>(owner ? `/workspaces/${workspace.id}/webhook/deliveries` : null, { pollMs: 8000 });
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [removing, setRemoving] = useState(false);
  const [busy, setBusy] = useState<'save' | 'rotate' | 'test' | 'delete' | null>(null);
  useEffect(() => {
    if (!hook.data) return;
    setUrl(hook.data.url ?? '');
    setEvents(hook.data.events ?? hook.data.availableEvents);
  }, [hook.data]);
  if (!owner) return <Notice tone="gray">Only the workspace owner can view and change the webhook endpoint.</Notice>;
  if (!hook.data) return <Spinner />;
  const wh = hook.data;

  const run = async (which: typeof busy, fn: () => Promise<void>) => {
    setBusy(which);
    try {
      await fn();
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'red');
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run('save', async () => {
      const res = await api<{ secret?: string }>(`/workspaces/${workspace.id}/webhook`, { method: 'PUT', body: { url: url.trim(), events } });
      if (res.secret) setSecret(res.secret);
      toast(wh.configured ? 'Webhook updated.' : 'Webhook saved. Copy the signing secret below — it is shown once.');
      await hook.reload();
    });
  const rotate = () =>
    run('rotate', async () => {
      const res = await api<{ secret?: string }>(`/workspaces/${workspace.id}/webhook`, { method: 'PUT', body: { url: wh.url, events: wh.events, rotateSecret: true } });
      if (res.secret) setSecret(res.secret);
      toast('Signing secret rotated. Update the receiver with the new secret below — it is shown once.');
      await hook.reload();
    });
  const remove = () =>
    run('delete', async () => {
      await api(`/workspaces/${workspace.id}/webhook`, { method: 'DELETE' });
      setRemoving(false);
      setSecret(null);
      toast('Webhook removed.');
      await hook.reload();
    });
  const sendTest = () =>
    run('test', async () => {
      const d = await api<WebhookDelivery>(`/workspaces/${workspace.id}/webhook/test`, { method: 'POST' });
      toast(d.status === 'delivered' ? `Test event delivered (HTTP ${d.responseStatus}).` : `Test event failed: ${d.error ?? `HTTP ${d.responseStatus}`}`, d.status === 'delivered' ? 'green' : 'red');
      await deliveries.reload();
    });

  return (
    <div className="space-y-6">
      <Card title="Workspace webhook" description="LexCompiler posts signed JSON events to one endpoint, for example an n8n workflow. Deliveries are retried, and every one carries X-LexCompiler-Signature.">
        {secret && (
          <Notice tone="green" action={<CopyButton text={secret} label="Copy secret" />}>
            Store the signing secret now — it is shown once. <Mono className="break-all">{secret}</Mono>
          </Notice>
        )}
        <div className="mt-4 space-y-4">
          <Field label="Endpoint URL" htmlFor="webhook-url" hint="Use https. Plain http and private or loopback hosts are refused unless the server opts in.">
            <Input id="webhook-url" type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://n8n.example.com/webhook/lexcompiler" />
          </Field>
          <Field label="Events" hint="The event types the endpoint receives.">
            <div className="flex flex-wrap gap-2">
              {wh.availableEvents.map((e) => (
                <label
                  key={e}
                  className={cx(
                    'flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs',
                    events.includes(e) ? 'border-indigo-500 bg-indigo-50 text-indigo-800' : 'border-zinc-200 text-zinc-600 hover:border-zinc-300'
                  )}
                >
                  <input type="checkbox" className="sr-only" checked={events.includes(e)} onChange={() => setEvents((ev) => (ev.includes(e) ? ev.filter((x) => x !== e) : [...ev, e]))} />
                  <Mono>{e}</Mono>
                </label>
              ))}
            </div>
          </Field>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" loading={busy === 'save'} disabled={!url.trim() || events.length === 0} onClick={save}>
              {wh.configured ? 'Save changes' : 'Create webhook'}
            </Button>
            {wh.configured && (
              <>
                <Button icon={<Send className="size-4" />} loading={busy === 'test'} onClick={sendTest}>
                  Send test event
                </Button>
                <Button loading={busy === 'rotate'} onClick={rotate}>
                  Rotate secret
                </Button>
                <Button variant="danger" onClick={() => setRemoving(true)}>
                  Remove
                </Button>
              </>
            )}
          </div>
          {wh.configured && (
            <div className="text-xs text-zinc-500">
              Created {formatDate(wh.createdAt, true)} · updated {timeAgo(wh.updatedAt)}
            </div>
          )}
        </div>
      </Card>
      <Card title="Deliveries" description="The last 50 deliveries, newest first." padded={false}>
        {!deliveries.data ? (
          <Spinner />
        ) : deliveries.data.length === 0 ? (
          <EmptyState icon={<Webhook className="size-5" />} title="No deliveries yet" description="Send a test event to check the endpoint." />
        ) : (
          <Table
            head={
              <>
                <Th>Event</Th>
                <Th>Status</Th>
                <Th>Attempts</Th>
                <Th>Response</Th>
                <Th>Error</Th>
                <Th className="text-right">When</Th>
              </>
            }
          >
            {deliveries.data.map((d) => (
              <tr key={d.id} className="hover:bg-zinc-50">
                <Td>
                  <Mono>{d.eventType}</Mono>
                </Td>
                <Td>
                  <Badge tone={d.status === 'delivered' ? 'green' : d.status === 'failed' ? 'red' : 'amber'}>{d.status}</Badge>
                </Td>
                <Td className="text-xs text-zinc-500">{d.attempts}</Td>
                <Td className="text-xs text-zinc-500">{d.responseStatus ?? '—'}</Td>
                <Td className="max-w-64 truncate text-xs text-zinc-500">
                  <span title={d.error ?? ''}>{d.error ?? '—'}</span>
                </Td>
                <Td className="whitespace-nowrap text-right text-xs text-zinc-500">
                  <span title={new Date(d.deliveredAt ?? d.createdAt).toLocaleString()}>{timeAgo(d.deliveredAt ?? d.createdAt)}</span>
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <Modal
        open={removing}
        title="Remove the webhook"
        description="Event deliveries stop immediately and the signing secret is discarded."
        onClose={() => setRemoving(false)}
        footer={
          <>
            <Button onClick={() => setRemoving(false)}>Cancel</Button>
            <Button variant="danger" loading={busy === 'delete'} onClick={remove}>
              Remove webhook
            </Button>
          </>
        }
      >
        {wh.url && (
          <div className="text-sm text-zinc-600">
            Endpoint <Mono className="break-all">{wh.url}</Mono>
          </div>
        )}
      </Modal>
    </div>
  );
}
