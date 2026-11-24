// Email transport. In this app it records messages in an outbox (tests read it).
export function createMailer() {
  const outbox = [];
  return {
    outbox,
    send({ to, subject, text }) {
      if (!to || !subject) throw new Error('to and subject are required');
      outbox.push({ to, subject, text: text ?? '', sentAt: new Date().toISOString() });
    },
  };
}
