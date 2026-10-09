// The spending guard. Only the mail transport may invoke this stop-only AWS
// function, which has no operation that enables service or raises a budget.
// Operator alerts go out at 50, 75 and 90 per cent of the monthly reserve;
// at 100 the AWS guard sends its own notice, independently of SES.
function createGuard(db, env, sender) {
  const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
  const { SendEmailCommand } = require('@aws-sdk/client-sesv2');
  const client = new LambdaClient({ region: env.AWS_REGION });
  if (!env.ASSISTANT_EMAIL_GUARD_FUNCTION || !env.ASSISTANT_EMAIL_OPERATOR) throw new Error('Email budget protection is not configured.');
  let stoppedAt = 0;
  return {
    async cutoff() {
      const result = await db.from('mail_relay_controls').update({ paused: true }).eq('id', true);
      if (result.error) throw new Error('Could not pause email.');
      if (Date.now() - stoppedAt < 60000) return;
      const response = await client.send(new InvokeCommand({ FunctionName: env.ASSISTANT_EMAIL_GUARD_FUNCTION, InvocationType: 'RequestResponse', Payload: Buffer.from(JSON.stringify({ action: 'pause' })) }));
      const body = JSON.parse(Buffer.from(response.Payload || []).toString());
      if (response.FunctionError || !body.paused) throw new Error('AWS email cutoff failed.');
      stoppedAt = Date.now();
    },
    async notify({ threshold, used, budget }) {
      // The AWS guard sends the final notice through SNS, independently of SES.
      if (threshold === 100) return;
      await sender.send(new SendEmailCommand({ FromEmailAddress: 'alerts@assist.closedhand.ai', Destination: { ToAddresses: [env.ASSISTANT_EMAIL_OPERATOR] }, Content: { Simple: {
        Subject: { Data: `Closedhand email budget: ${threshold}%` },
        Body: { Text: { Data: `Estimated email usage this month is $${used.toFixed(2)} against the $${budget.toFixed(2)} operating reserve. Review usage before increasing capacity. The service pauses at the reserve; the AWS billing alerts are separate. No limit has been raised automatically.` } }
      } } }));
    },
    close() { client.destroy(); }
  };
}
module.exports = { createGuard };
