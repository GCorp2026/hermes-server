import { db } from '../db';

function json(data: unknown, status = 200) {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  };
  return new Response(JSON.stringify(data), { status, headers: corsHeaders });
}

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';

// POST /api/auth/email-send — equivalent to Supabase send-email edge function
export async function handleHermesEmailSend(req: Request, token: string, userId: string): Promise<Response> {
  try {
    const { to, cc, bcc, subject, content, html_content, work_email_id, scheduled_at, attachments } = await req.json();

    if (!to || !subject || !work_email_id) {
      return json({ error: 'Missing required fields: to, subject, work_email_id' }, 400);
    }

    // Verify user owns this work email
    const [workEmail] = await db`SELECT * FROM public.hermes_work_emails WHERE id = ${work_email_id} AND user_id = ${userId}`.execute();
    if (!workEmail) {
      return json({ error: 'Work email not found or unauthorized' }, 403);
    }

    const toAddresses = Array.isArray(to) ? to : [to];
    const ccAddresses = cc?.length ? cc : null;
    const bccAddresses = bcc?.length ? bcc : null;
    const attachmentPaths = attachments?.map((a: { path: string }) => a.path) || null;

    // Scheduled send — store in scheduled_emails
    if (scheduled_at) {
      await db`INSERT INTO scheduled_emails (work_email_id, to_addresses, cc_addresses, bcc_addresses, subject, content, html_content, attachments, scheduled_at, status)
        VALUES (${work_email_id}, ${toAddresses}, ${ccAddresses}, ${bccAddresses}, ${subject}, ${content || null}, ${html_content || null}, ${attachmentPaths}, ${scheduled_at}, 'pending')`.execute();
      return json({ success: true, scheduled: true });
    }

    if (!RESEND_API_KEY) {
      return json({ error: 'Resend API key not configured' }, 500);
    }

    // Build from address
    const fromAddress = workEmail.display_name
      ? `${workEmail.display_name} <${workEmail.work_email || workEmail.work_email}>`
      : (workEmail.work_email || workEmail.work_email);

    const resendPayload: Record<string, unknown> = {
      from: fromAddress,
      to: toAddresses,
      subject,
    };
    if (html_content) resendPayload.html = html_content;
    else if (content) resendPayload.text = content;
    if (ccAddresses) resendPayload.cc = ccAddresses;
    if (bccAddresses) resendPayload.bcc = bccAddresses;

    const resendRes = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
      body: JSON.stringify(resendPayload),
    });

    const resendData = await resendRes.json();

    // Store in email_history
    await db`INSERT INTO public.hermes_email_history (id, work_email_id, resend_email_id, direction, from_address, to_addresses, cc_addresses, bcc_addresses, subject, content, html_content, status, error_message, attachments, created_at)
      VALUES (gen_random_uuid(), ${work_email_id}, ${resendData.id || null}, 'sent', ${workEmail.work_email || workEmail.work_email}, ${toAddresses}, ${ccAddresses}, ${bccAddresses}, ${subject}, ${content || null}, ${html_content || null}, ${resendRes.ok ? 'sent' : 'failed'}, ${resendRes.ok ? null : JSON.stringify(resendData)}, ${attachmentPaths}, NOW())`.execute();

    // Also store in public.hermes_emails so it appears in the admin panel
    await db`INSERT INTO public.hermes_emails (id, user_id, from_address, to_addresses, subject, body, body_html, status, direction, work_email_id, resend_email_id, cc_addresses, bcc_addresses, error_message, attachments, last_event, created_at, updated_at)
      VALUES (gen_random_uuid(), ${userId}, ${workEmail.work_email || workEmail.work_email}, ${toAddresses}, ${subject}, ${content || null}, ${html_content || null}, ${resendRes.ok ? 'sent' : 'failed'}, 'outbound', ${work_email_id}, ${resendData.id || null}, ${ccAddresses}, ${bccAddresses}, ${resendRes.ok ? null : JSON.stringify(resendData)}, ${attachmentPaths}, NULL, NOW(), NOW())`.execute();

    if (!resendRes.ok) {
      return json({ error: 'Failed to send email', details: resendData }, 500);
    }

    return json({ success: true, id: resendData.id });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/auth/process-scheduled — process pending scheduled emails
export async function handleProcessScheduled(req: Request): Promise<Response> {
  try {
    if (!RESEND_API_KEY) {
      return json({ error: 'Resend API key not configured' }, 500);
    }

    const now = new Date().toISOString();
    const pending = await db`SELECT * FROM scheduled_emails WHERE status = 'pending' AND scheduled_at <= ${now} LIMIT 10`.execute();

    const results = [];
    for (const scheduled of pending) {
      const [workEmail] = await db`SELECT * FROM public.hermes_work_emails WHERE id = ${scheduled.work_email_id}`.execute();
      if (!workEmail) {
        await db`UPDATE scheduled_emails SET status = 'failed', error_message = 'Work email not found' WHERE id = ${scheduled.id}`.execute();
        results.push({ id: scheduled.id, status: 'failed', reason: 'no work email' });
        continue;
      }

      const fromAddress = workEmail.display_name
        ? `${workEmail.display_name} <${workEmail.work_email || workEmail.work_email}>`
        : (workEmail.work_email || workEmail.work_email);

      const resendPayload: Record<string, unknown> = {
        from: fromAddress,
        to: scheduled.to_addresses,
        subject: scheduled.subject,
      };
      if (scheduled.html_content) resendPayload.html = scheduled.html_content;
      else if (scheduled.content) resendPayload.text = scheduled.content;
      if (scheduled.cc_addresses?.length) resendPayload.cc = scheduled.cc_addresses;
      if (scheduled.bcc_addresses?.length) resendPayload.bcc = scheduled.bcc_addresses;

      try {
        const resendRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND_API_KEY}` },
          body: JSON.stringify(resendPayload),
        });
        const resendData = await resendRes.json();

        if (resendRes.ok) {
          await db`UPDATE scheduled_emails SET status = 'sent', sent_at = NOW() WHERE id = ${scheduled.id}`.execute();
          await db`INSERT INTO public.hermes_email_history (id, work_email_id, resend_email_id, direction, from_address, to_addresses, cc_addresses, bcc_addresses, subject, content, html_content, status, attachments, created_at)
            VALUES (gen_random_uuid(), ${scheduled.work_email_id}, ${resendData.id || null}, 'sent', ${workEmail.work_email || workEmail.work_email}, ${scheduled.to_addresses}, ${scheduled.cc_addresses}, ${scheduled.bcc_addresses}, ${scheduled.subject}, ${scheduled.content}, ${scheduled.html_content}, 'sent', ${scheduled.attachments}, NOW())`.execute();
          // Also store in public.hermes_emails so it appears in the admin panel
          await db`INSERT INTO public.hermes_emails (id, user_id, from_address, to_addresses, subject, body, body_html, status, direction, work_email_id, resend_email_id, cc_addresses, bcc_addresses, error_message, attachments, last_event, created_at, updated_at)
            VALUES (gen_random_uuid(), ${workEmail.user_id}, ${workEmail.work_email || workEmail.work_email}, ${scheduled.to_addresses}, ${scheduled.subject}, ${scheduled.content}, ${scheduled.html_content}, 'sent', 'outbound', ${scheduled.work_email_id}, ${resendData.id || null}, ${scheduled.cc_addresses}, ${scheduled.bcc_addresses}, NULL, ${scheduled.attachments}, NULL, NOW(), NOW())`.execute();
          results.push({ id: scheduled.id, status: 'sent' });
        } else {
          await db`UPDATE scheduled_emails SET status = 'failed', error_message = ${JSON.stringify(resendData)} WHERE id = ${scheduled.id}`.execute();
          results.push({ id: scheduled.id, status: 'failed' });
        }
      } catch (sendErr: any) {
        await db`UPDATE scheduled_emails SET status = 'failed', error_message = ${sendErr.message} WHERE id = ${scheduled.id}`.execute();
        results.push({ id: scheduled.id, status: 'failed', error: sendErr.message });
      }
    }

    return json({ processed: results.length, results });
  } catch (e: any) {
    return json({ error: e.message }, 500);
  }
}

// POST /api/webhooks/resend — equivalent to Supabase resend-webhook edge function
export async function handleResendWebhook(req: Request): Promise<Response> {
  try {
    const payload = await req.json();
    const type = payload.type;
    let data = payload.data || payload.payload;
    if (!type || !data) return json({ error: 'Invalid webhook payload' }, 400);

    const emailId = data.email_id || data.id;
    if (!emailId) return json({ received: true, skipped: 'no_email_id' });

    let status: string | null = null;
    let lastEvent: string | null = type;
    switch (type) {
      case 'email.sent': status = 'sent'; break;
      case 'email.delivered': status = 'delivered'; break;
      case 'email.bounced': status = 'bounced'; break;
      case 'email.complained': status = 'complained'; break;
      case 'email.delivery_delayed': lastEvent = 'delivery_delayed'; break;
      case 'email.opened': lastEvent = 'opened'; break;
      case 'email.clicked': lastEvent = 'clicked'; break;
    }

    if (status) {
      await db`UPDATE public.hermes_email_history SET last_event = ${lastEvent}, status = ${status} WHERE resend_email_id = ${emailId}`.execute();
    } else if (lastEvent) {
      await db`UPDATE public.hermes_email_history SET last_event = ${lastEvent} WHERE resend_email_id = ${emailId}`.execute();
    }

    if (type === 'email.received') {
      if ((!data.from || !data.to) && RESEND_API_KEY) {
        const recv = await fetch(`https://api.resend.com/emails/receiving/${emailId}`, {
          headers: { Authorization: `Bearer ${RESEND_API_KEY}` },
        });
        if (recv.ok) data = { ...data, ...(await recv.json()) };
      }

      const toRaw = data.to || data.to_addresses || data.recipients;
      const toAddresses = Array.isArray(toRaw) ? toRaw : [toRaw].filter(Boolean);
      const fromAddress = typeof data.from === 'object' ? data.from.email : data.from;
      const matchAddresses = toAddresses.map((a: any) =>
        String(typeof a === 'object' ? a.email : a).toLowerCase()
      );

      if (fromAddress && matchAddresses.length) {
        const [workEmail] = await db`
          SELECT id, user_id FROM public.hermes_work_emails
          WHERE lower(work_email) = ANY(${matchAddresses})
             OR lower(work_email) = ANY(${matchAddresses})
          LIMIT 1
        `.execute();
        if (workEmail) {
          await db`INSERT INTO public.hermes_email_history (id, work_email_id, resend_email_id, direction, from_address, to_addresses, subject, content, html_content, status, created_at)
            VALUES (gen_random_uuid(), ${workEmail.id}, ${emailId}, 'received', ${fromAddress}, ${matchAddresses}, ${data.subject || '(no subject)'}, ${data.text || data.text_body || null}, ${data.html || data.html_body || null}, 'received', NOW())
            ON CONFLICT DO NOTHING`.execute();
          // Also store in public.hermes_emails so it appears in the admin panel
          await db`INSERT INTO public.hermes_emails (id, user_id, from_address, to_addresses, subject, body, body_html, status, direction, work_email_id, resend_email_id, cc_addresses, bcc_addresses, error_message, attachments, last_event, created_at, updated_at)
            VALUES (gen_random_uuid(), ${workEmail.user_id}, ${fromAddress}, ${matchAddresses}, ${data.subject || '(no subject)'}, ${data.text || data.text_body || null}, ${data.html || data.html_body || null}, 'received', 'inbound', ${workEmail.id}, ${emailId}, '{}', '{}', NULL, '{}', NULL, NOW(), NOW())
            ON CONFLICT DO NOTHING`.execute();
        }
      }
    }

    return json({ received: true });
  } catch (e: any) {
    console.error('resend webhook error:', e);
    return json({ error: e.message }, 500);
  }
}
