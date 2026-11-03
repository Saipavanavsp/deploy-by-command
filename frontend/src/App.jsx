import { useCallback, useEffect, useRef, useState } from 'react';
import { api, OPERATION_CALLS } from './api.js';

const EXAMPLES = ['Deploy my website', 'Launch a server', 'Install Docker on the server', 'What is the status?', 'Restart the app'];
const STEPS = [
  ['launch', 'Launch'],
  ['configure', 'Configure'],
  ['deploy', 'Deploy'],
];
const SUPPORTED = [
  ['LAUNCH', 'Create the cloud server only'],
  ['CONFIGURE', 'Install and verify Docker'],
  ['DEPLOY', 'Deploy to a configured server'],
  ['FULL_DEPLOY', 'Deploy my website end to end (finished steps skipped)'],
  ['STATUS', 'Check server, container and website'],
  ['RESTART', 'Restart the container'],
];

const SpeechRecognition = typeof window !== 'undefined' ? window.SpeechRecognition || window.webkitSpeechRecognition : null;

function Card({ title, children, className = '', actions }) {
  return (
    <section className={`card ${className}`}>
      <header className="card-head">
        <h2>{title}</h2>
        {actions}
      </header>
      {children}
    </section>
  );
}

function Badge({ kind, children, title }) {
  return <span className={`badge badge-${kind}`} title={title}>{children}</span>;
}

export default function App() {
  const [health, setHealth] = useState(null);
  const [state, setState] = useState(null);
  const [text, setText] = useState('');
  const [interp, setInterp] = useState(null);
  const [pending, setPending] = useState(null); // interpreted operation awaiting confirmation (real mode)
  const [error, setError] = useState('');
  const [logs, setLogs] = useState([]);
  const [listening, setListening] = useState(false);
  const [showTerminate, setShowTerminate] = useState(false);
  const [confirmText, setConfirmText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const lastLogId = useRef(0);
  const logBox = useRef(null);
  const recognizer = useRef(null);

  const simulated = health ? health.mode === 'mock' : true;
  const busy = Boolean(state?.busy);

  const refreshState = useCallback(async () => {
    try {
      setState(await api.state());
    } catch (e) {
      setError(e.message);
    }
  }, []);

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setError(e.message));
    refreshState();
  }, [refreshState]);

  // Poll /logs every 1 s (and /state with it).
  useEffect(() => {
    const timer = setInterval(async () => {
      try {
        const data = await api.logs(lastLogId.current);
        if (data.logs.length) {
          lastLogId.current = data.lastId;
          setLogs((prev) => [...prev, ...data.logs].slice(-1000));
        }
        setState(await api.state());
      } catch {
        /* the next poll will try again; persistent problems show via actions */
      }
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (logBox.current) logBox.current.scrollTop = logBox.current.scrollHeight;
  }, [logs]);

  async function runAction(fn, label) {
    setError('');
    try {
      await fn();
      await refreshState();
    } catch (e) {
      setError(`${label}: ${e.message}`);
    }
  }

  async function submitCommand(value = text) {
    const command = value.trim();
    if (!command) {
      setError('Type or say a command first.');
      return;
    }
    setError('');
    setPending(null);
    setSubmitting(true);
    try {
      const r = await api.command(command);
      setInterp({ ...r, text: command });
      if (r.intent !== 'UNKNOWN' && r.operation) {
        if (simulated) await runAction(OPERATION_CALLS[r.operation], r.intent);
        else setPending(r);
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  function toggleSpeech() {
    if (!SpeechRecognition) return;
    if (listening) {
      recognizer.current?.stop();
      return;
    }
    const rec = new SpeechRecognition();
    rec.lang = 'en-US';
    rec.interimResults = false;
    rec.maxAlternatives = 1;
    rec.onresult = (ev) => {
      const said = ev.results[0][0].transcript.slice(0, 300);
      setText(said);
      submitCommand(said);
    };
    rec.onerror = (ev) => setError(`Voice input failed: ${ev.error}. You can type the command instead.`);
    rec.onend = () => setListening(false);
    recognizer.current = rec;
    setListening(true);
    rec.start();
  }

  async function doTerminate() {
    await runAction(() => api.terminate(confirmText), 'TERMINATE');
    setConfirmText('');
    setShowTerminate(false);
  }

  const infra = state?.infra;
  const result = state?.lastResult;
  const deployment = state?.deployment;

  return (
    <div className="page">
      <header className="top">
        <div>
          <h1>Deploy by Command</h1>
          <p className="subtitle">Say or type what you want. An LLM picks one approved action; the backend runs it.</p>
        </div>
        <div className="badges">
          <Badge kind={simulated ? 'mock' : 'real'}>{simulated ? 'SIMULATED · MOCK' : 'REAL AWS'}</Badge>
          <Badge kind="engine" title="Which engine interprets commands">
            Engine: {interp?.engine || health?.engine || '—'}
          </Badge>
        </div>
      </header>

      {simulated ? (
        <div className="banner banner-mock">
          Simulated mode. Nothing below touches AWS, SSH or Docker, and the &lsquo;public IP&rsquo; is a reserved example address. Logs are tagged [SIMULATED].
        </div>
      ) : (
        <div className="banner banner-real">
          Real AWS mode. Actions create and change billable resources in {state?.config?.region || 'your AWS region'}. Every interpreted command waits for your confirmation.
        </div>
      )}

      {error && (
        <div className="banner banner-error" role="alert">
          <strong>Error:</strong> {error}
          <button type="button" className="link" onClick={() => setError('')}>Dismiss</button>
        </div>
      )}

      <main className="grid">
        <div className="col">
          <Card title="Command">
            <form
              className="command-row"
              onSubmit={(e) => {
                e.preventDefault();
                submitCommand();
              }}
            >
              <input
                type="text"
                value={text}
                maxLength={300}
                placeholder='e.g. "Deploy my website"'
                onChange={(e) => setText(e.target.value)}
                aria-label="Command"
              />
              <button type="submit" className="primary" disabled={submitting || busy}>Run command</button>
              <button
                type="button"
                className={listening ? 'listening' : ''}
                onClick={toggleSpeech}
                disabled={!SpeechRecognition}
                title={SpeechRecognition ? 'Speak a command' : 'Voice input is not supported in this browser (try Chrome or Edge)'}
              >
                {listening ? 'Listening…' : 'Speak'}
              </button>
            </form>
            <div className="hint">{text.length}/300</div>
            <div className="chips">
              {EXAMPLES.map((ex) => (
                <button type="button" key={ex} className="chip" onClick={() => setText(ex)}>{ex}</button>
              ))}
            </div>
          </Card>

          <Card title="Interpretation">
            {!interp && <p className="muted">Run a command to see how it was interpreted.</p>}
            {interp && (
              <div className="interp">
                <div className="kv"><span>Command</span><b>&ldquo;{interp.text}&rdquo;</b></div>
                <div className="kv"><span>Intent</span><b className={interp.intent === 'UNKNOWN' ? 'bad' : 'good'}>{interp.intent}</b></div>
                <div className="kv"><span>Engine</span><b>{interp.engine}</b></div>
                <div className="kv"><span>Confidence</span><b>{Number(interp.confidence).toFixed(2)}</b></div>
                <div className="kv"><span>Reason</span><span>{interp.reason}</span></div>
                {interp.warning && <div className="warn-line">{interp.warning}</div>}
                {interp.intent === 'UNKNOWN' ? (
                  <div className="noaction">
                    <b>No action. Nothing was run.</b>
                    <p>Supported actions:</p>
                    <ul>
                      {SUPPORTED.map(([i, m]) => (
                        <li key={i}><code>{i}</code> — {m}</li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <>
                    <p className="plan-title">Plan</p>
                    <ol className="plan">
                      {interp.plan.map((p) => <li key={p}>{p}</li>)}
                    </ol>
                  </>
                )}
                {pending && (
                  <div className="confirm-row">
                    <span>Run <b>{pending.intent}</b> on real AWS?</span>
                    <button
                      type="button"
                      className="primary"
                      disabled={busy}
                      onClick={async () => {
                        const op = pending.operation;
                        setPending(null);
                        await runAction(OPERATION_CALLS[op], pending.intent);
                      }}
                    >
                      Confirm
                    </button>
                    <button type="button" onClick={() => setPending(null)}>Cancel</button>
                  </div>
                )}
              </div>
            )}
          </Card>

          <Card title="Actions">
            <div className="actions">
              <button type="button" disabled={busy} onClick={() => runAction(api.launch, 'LAUNCH')}>Launch</button>
              <button type="button" disabled={busy} onClick={() => runAction(api.configure, 'CONFIGURE')}>Configure</button>
              <button type="button" disabled={busy} onClick={() => runAction(api.deploy, 'DEPLOY')}>Deploy</button>
              <button type="button" className="primary" disabled={busy} onClick={() => runAction(api.full, 'FULL_DEPLOY')}>Launch, configure and deploy</button>
              <button type="button" disabled={busy} onClick={() => runAction(api.status, 'STATUS')}>Check status</button>
              <button type="button" disabled={busy} onClick={() => runAction(api.restart, 'RESTART')}>Restart app</button>
              <button type="button" disabled={busy} onClick={() => runAction(api.cloudflare, 'CLOUDFLARE')}>Publish to Cloudflare</button>
              <button type="button" className="danger" disabled={busy} onClick={() => setShowTerminate((v) => !v)}>Terminate server</button>
            </div>
            {showTerminate && (
              <div className="terminate">
                <label htmlFor="confirm">
                  Type <code>TERMINATE</code> or the instance ID{infra?.instanceId ? <> (<code>{infra.instanceId}</code>)</> : ''} to confirm:
                </label>
                <div className="command-row">
                  <input id="confirm" type="text" value={confirmText} maxLength={100} onChange={(e) => setConfirmText(e.target.value)} />
                  <button type="button" className="danger" disabled={busy || !confirmText.trim()} onClick={doTerminate}>Confirm terminate</button>
                  <button type="button" onClick={() => setShowTerminate(false)}>Cancel</button>
                </div>
              </div>
            )}
          </Card>
        </div>

        <div className="col">
          <Card title="Progress" actions={busy ? <Badge kind="running">Running: {state?.currentOp}</Badge> : null}>
            <ul className="steps">
              {STEPS.map(([key, label]) => {
                const s = state?.steps?.[key] || 'pending';
                return (
                  <li key={key} className={`step step-${s}`}>
                    <span className="dot" />
                    <span className="step-name">{label}</span>
                    <span className="step-state">{s}</span>
                  </li>
                );
              })}
            </ul>
          </Card>

          <Card
            title="Execution logs"
            className="logs-card"
            actions={<button type="button" className="small" onClick={() => setLogs([])}>Clear view</button>}
          >
            <div className="console" ref={logBox}>
              {logs.length === 0 && <div className="muted-dark">No log lines yet.</div>}
              {logs.map((l) => (
                <div key={l.id} className={`line lvl-${l.level}`}>
                  <span className="ts">{new Date(l.ts).toLocaleTimeString()}</span>
                  <span className="lvl">{l.level}</span>
                  <span className="msg">{l.msg}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Result">
            {result ? (
              <p className={`status-line ${result.ok ? 'good' : 'bad'}`}>{result.message}</p>
            ) : (
              <p className="muted">No operation has finished yet.</p>
            )}
            {state?.lastError && !result?.message?.includes(state.lastError.message) && (
              <p className="bad">Last error: {state.lastError.message}</p>
            )}
            <div className="kv"><span>Server ID</span><b>{infra?.instanceId || '—'}</b></div>
            <div className="kv">
              <span>Public IP</span>
              <b>{infra?.publicIp ? `${infra.publicIp}${simulated ? ' (example address)' : ''}` : '—'}</b>
            </div>
            <div className="kv"><span>Docker</span><b>{state?.dockerReady ? 'ready' : 'not ready'}</b></div>
            <div className="kv">
              <span>Application URL</span>
              <b>
                {deployment?.url ? (
                  simulated ? <span title="Simulated: not a real address">{deployment.url}</span> : <a href={deployment.url} target="_blank" rel="noreferrer">{deployment.url}</a>
                ) : '—'}
                {deployment && (
                  <Badge kind={deployment.healthy ? 'ok' : 'fail'}>{deployment.healthy ? 'healthy' : 'unhealthy'}</Badge>
                )}
              </b>
            </div>
            {simulated && deployment?.url && <p className="muted small-text">This address is not real: it comes from the reserved documentation range 198.51.100.0/24.</p>}
            {state?.lastStatus && (
              <ul className="checks">
                {state.lastStatus.checks.map((c) => (
                  <li key={c.name} className={c.ok ? 'good' : 'bad'}>{c.ok ? '✔' : '✘'} {c.name}: {c.detail}</li>
                ))}
              </ul>
            )}
            {state?.cloudflare && (
              <div className="kv">
                <span>Cloudflare</span>
                <b>
                  <a href={state.cloudflare.url} target="_blank" rel="noreferrer">{state.cloudflare.url}</a>
                  <Badge kind={state.cloudflare.verified ? 'ok' : 'fail'}>{state.cloudflare.verified ? 'verified' : 'not verified'}</Badge>
                </b>
              </div>
            )}
          </Card>
        </div>
      </main>
      <footer className="foot">Backend on 127.0.0.1 only · no login · Terminate always needs typed confirmation</footer>
    </div>
  );
}
