import nodemailer from 'nodemailer';

function getSmtpAuthUser(): string {
  return String(process.env.SMTP_AUTH_USER || process.env.SMTP_USER || '').trim();
}

function getSmtpPass(): string {
  return String(process.env.SMTP_PASS || '').trim();
}

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST || 'smtp.hostinger.com',
  port: parseInt(process.env.SMTP_PORT || '465'),
  secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true' || process.env.SMTP_PORT === '465',
  auth: {
    user: getSmtpAuthUser(),
    pass: getSmtpPass(),
  },
});

export async function sendEmail(
  to: string | string[],
  subject: string,
  html: string,
  headers?: Record<string, string>
) {
  const smtpUser = getSmtpAuthUser();
  const smtpPass = getSmtpPass();
  if (!smtpUser || !smtpPass) {
    throw new Error('SMTP not configured: set SMTP_USER/SMTP_AUTH_USER and SMTP_PASS (Hostinger mailbox credentials)');
  }

  return transporter.sendMail({
    from: `"AppsMagic Events" <${process.env.SMTP_FROM || process.env.SMTP_USER || 'no-reply@appsmagic.in'}>`,
    to: Array.isArray(to) ? to.join(', ') : to,
    subject,
    html,
    headers,
  });
}

type PremiumInviteTemplate = 'birthday' | 'wedding' | 'corporate';

function resolvePremiumInviteTemplate(event: {
  invite_template?: string | null;
  title?: string | null;
  tags?: string | null;
  description?: string | null;
}): PremiumInviteTemplate {
  const explicit = String(event.invite_template || '').trim().toLowerCase();
  if (explicit === 'birthday' || explicit === 'wedding' || explicit === 'corporate') return explicit;

  const haystack = `${event.title || ''} ${event.tags || ''} ${event.description || ''}`.toLowerCase();
  if (/(wedding|marriage|engagement|reception|sangeet|nikah|shaadi)/.test(haystack)) return 'wedding';
  if (/(birthday|naming|baby|party|celebration)/.test(haystack)) return 'birthday';
  return 'corporate';
}

export function eventInviteTemplate(event: {
  title: string;
  description: string | null;
  start_date: string;
  end_date: string;
  venue_name: string;
  city: string;
  is_online: boolean;
  is_free: boolean;
  price: number;
  currency: string;
  banner_url: string | null;
  organizer_name: string;
  invite_template?: string | null;
  tags?: string | null;
}, eventUrl: string, customMessage?: string, unsubscribeUrl?: string) {
  const date = new Date(event.start_date);
  const dateStr = date.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const location = event.is_online ? 'Online Event' : `${event.venue_name}, ${event.city}`;
  const price = event.is_free ? 'Free' : `${event.currency} ${event.price}`;
  const banner = event.banner_url || 'https://images.unsplash.com/photo-1540575467063-178a50c2df87?w=800&q=80';
  const description = String(event.description || '').trim();
  const template = resolvePremiumInviteTemplate(event);
  const themeByTemplate: Record<PremiumInviteTemplate, {
    label: string;
    line: string;
    gradient: string;
    accentBg: string;
    accentBorder: string;
    accentText: string;
    cta: string;
  }> = {
    birthday: {
      label: 'Birthday Invite',
      line: 'Join us for a joyful celebration',
      gradient: 'linear-gradient(135deg,#db2777,#f97316)',
      accentBg: '#fff1f2',
      accentBorder: '#fda4af',
      accentText: '#be123c',
      cta: 'View Birthday Invite',
    },
    wedding: {
      label: 'Wedding Invite',
      line: 'We would love your presence on this special day',
      gradient: 'linear-gradient(135deg,#a855f7,#ec4899)',
      accentBg: '#fdf4ff',
      accentBorder: '#f0abfc',
      accentText: '#86198f',
      cta: 'Open Wedding Invite',
    },
    corporate: {
      label: 'Corporate Invite',
      line: 'You are invited to an exclusive event experience',
      gradient: 'linear-gradient(135deg,#0f766e,#0284c7)',
      accentBg: '#f0fdfa',
      accentBorder: '#99f6e4',
      accentText: '#0f766e',
      cta: 'Open Event Invite',
    },
  };
  const theme = themeByTemplate[template];

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>You're Invited: ${event.title}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:32px 16px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
        <tr>
          <td style="background:${theme.gradient};padding:32px 40px;text-align:center;">
            <p style="margin:0 0 8px;font-size:12px;font-weight:800;letter-spacing:2px;text-transform:uppercase;color:rgba(255,255,255,0.75);">${theme.label}</p>
            <h1 style="margin:0;font-size:28px;font-weight:800;color:#fff;line-height:1.2;">${event.title}</h1>
            <p style="margin:10px 0 0;font-size:14px;color:rgba(255,255,255,0.92);">${theme.line}</p>
            <p style="margin:12px 0 0;font-size:14px;color:rgba(255,255,255,0.8);">Hosted by ${event.organizer_name}</p>
          </td>
        </tr>
        <tr>
          <td style="padding:0;">
            <img src="${banner}" alt="${event.title}" width="600" style="display:block;width:100%;max-height:240px;object-fit:cover;" />
          </td>
        </tr>
        <tr>
          <td style="background:#fff;padding:40px;">
            ${customMessage ? `<div style="background:${theme.accentBg};border-left:4px solid ${theme.accentBorder};border-radius:0 8px 8px 0;padding:16px 20px;margin-bottom:28px;"><p style="margin:0;font-size:14px;color:${theme.accentText};font-style:italic;">"${customMessage}"</p></div>` : ''}
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:28px;">
              <tr>
                <td style="padding:12px;background:#f8fafc;border-radius:12px 12px 0 0;border:1px solid #e2e8f0;border-bottom:none;">
                  <p style="margin:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;">📅 Date & Time</p>
                  <p style="margin:4px 0 0;font-size:15px;font-weight:600;color:#1e293b;">${dateStr} at ${timeStr}</p>
                </td>
              </tr>
              <tr>
                <td style="padding:12px;background:#f8fafc;border:1px solid #e2e8f0;border-bottom:none;border-top:none;">
                  <p style="margin:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;">📍 Location</p>
                  <p style="margin:4px 0 0;font-size:15px;font-weight:600;color:#1e293b;">${location}</p>
                </td>
              </tr>
              <tr>
                <td style="padding:12px;background:#f8fafc;border-radius:0 0 12px 12px;border:1px solid #e2e8f0;">
                  <p style="margin:0;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:1px;color:#94a3b8;">🎟️ Entry</p>
                  <p style="margin:4px 0 0;font-size:15px;font-weight:600;color:${event.is_free ? '#059669' : '#7c3aed'};">${price}</p>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 28px;font-size:14px;color:#64748b;line-height:1.7;">${description ? `${description.substring(0, 300)}${description.length > 300 ? '...' : ''}` : 'You are invited to join this event.'}</p>
            <div style="text-align:center;">
              <a href="${eventUrl}" style="display:inline-block;background:${theme.gradient};color:#fff;font-size:15px;font-weight:700;text-decoration:none;padding:14px 36px;border-radius:12px;box-shadow:0 4px 12px rgba(15,23,42,0.2);">
                ${theme.cta} →
              </a>
              <p style="margin:12px 0 0;font-size:12px;color:#94a3b8;">Or paste this link: <a href="${eventUrl}" style="color:${theme.accentText};">${eventUrl}</a></p>
            </div>
          </td>
        </tr>
        <tr>
          <td style="background:#f8fafc;padding:24px 40px;text-align:center;border-top:1px solid #e2e8f0;">
            <p style="margin:0;font-size:12px;color:#94a3b8;">Sent via <a href="https://events.appsmagic.in" style="color:${theme.accentText};font-weight:600;">AppsMagic Events</a> · <a href="https://appsmagic.in" style="color:#94a3b8;">AppsMagic</a></p>
            <p style="margin:6px 0 0;font-size:11px;color:#cbd5e1;">You received this because someone invited you to this event.</p>
            ${unsubscribeUrl ? `<p style="margin:6px 0 0;font-size:11px;"><a href="${unsubscribeUrl}" style="color:#64748b;">Unsubscribe from campaign emails</a></p>` : ''}
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

export function rsvpConfirmationTemplate(event: {
  title: string;
  start_date: string;
  end_date?: string | null;
  organizer_name?: string | null;
  venue_name: string;
  venue_address?: string | null;
  city: string;
  is_online: boolean;
  online_link: string | null;
  short_event_id?: string | null;
  join_url?: string | null;
  join_manual_url?: string | null;
}, ticketCode: string, eventUrl: string) {
  const date = new Date(event.start_date);
  const dateStr = date.toLocaleDateString('en-IN', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const startTime = date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const end = event.end_date ? new Date(event.end_date) : null;
  const endTime = end && !Number.isNaN(end.getTime())
    ? end.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })
    : '';
  const timeStr = endTime ? `${startTime} - ${endTime}` : startTime;
  const location = event.is_online ? 'Online Meeting' : `${event.venue_name}, ${event.city}`;
  const shortEventId = (event.short_event_id || '').trim() || 'N/A';
  const joinUrl = event.join_url || eventUrl;
  const manualJoinUrl = event.join_manual_url || eventUrl;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>RSVP Confirmed - ${event.title}</title>
</head>
<body style="margin:0;padding:0;background:#f3f5f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">Your RSVP is confirmed. Event ID: ${shortEventId}. Ticket code: ${ticketCode}.</div>
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f3f5f8;padding:28px 12px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">
        <tr>
          <td style="background:#0f766e;padding:24px 28px;text-align:left;">
            <p style="margin:0;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#99f6e4;font-weight:700;">AppsMagic Events</p>
            <h1 style="margin:8px 0 0;font-size:24px;line-height:1.2;color:#ffffff;font-weight:800;">RSVP Confirmed</h1>
            <p style="margin:10px 0 0;font-size:14px;color:#ccfbf1;">You are confirmed for <strong>${event.title}</strong>.</p>
          </td>
        </tr>
        <tr>
          <td style="padding:24px 28px;">
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:18px;">
              <tr><td style="padding:12px;border:1px solid #e5e7eb;border-radius:10px;background:#f9fafb;">
                <p style="margin:0;font-size:12px;color:#6b7280;">Event</p>
                <p style="margin:4px 0 0;font-size:16px;color:#111827;font-weight:700;">${event.title}</p>
              </td></tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
              <tr><td style="padding:12px 14px;border-bottom:1px solid #e5e7eb;background:#ffffff;">
                <p style="margin:0;font-size:12px;color:#6b7280;">Event ID</p>
                <p style="margin:4px 0 0;font-size:15px;font-family:ui-monospace,Menlo,monospace;color:#111827;font-weight:700;">${shortEventId}</p>
              </td></tr>
              <tr><td style="padding:12px 14px;border-bottom:1px solid #e5e7eb;background:#ffffff;">
                <p style="margin:0;font-size:12px;color:#6b7280;">Ticket Code</p>
                <p style="margin:4px 0 0;font-size:18px;font-family:ui-monospace,Menlo,monospace;letter-spacing:1px;color:#1d4ed8;font-weight:800;">${ticketCode}</p>
              </td></tr>
              <tr><td style="padding:12px 14px;border-bottom:1px solid #e5e7eb;background:#ffffff;">
                <p style="margin:0;font-size:12px;color:#6b7280;">Date & Time</p>
                <p style="margin:4px 0 0;font-size:15px;color:#111827;font-weight:600;">${dateStr} • ${timeStr}</p>
              </td></tr>
              <tr><td style="padding:12px 14px;background:#ffffff;">
                <p style="margin:0;font-size:12px;color:#6b7280;">Location</p>
                <p style="margin:4px 0 0;font-size:15px;color:#111827;font-weight:600;">${location}</p>
              </td></tr>
            </table>
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
              ${event.organizer_name ? `<tr><td style="padding:12px 14px;border-bottom:1px solid #e5e7eb;background:#ffffff;"><p style="margin:0;font-size:12px;color:#6b7280;">Host</p><p style="margin:4px 0 0;font-size:14px;color:#111827;font-weight:600;">${event.organizer_name}</p></td></tr>` : ''}
              ${event.venue_address ? `<tr><td style="padding:12px 14px;border-bottom:1px solid #e5e7eb;background:#ffffff;"><p style="margin:0;font-size:12px;color:#6b7280;">Venue Address</p><p style="margin:4px 0 0;font-size:14px;color:#111827;line-height:1.4;">${event.venue_address}</p></td></tr>` : ''}
              <tr><td style="padding:12px 14px;background:#ffffff;"><p style="margin:0;font-size:12px;color:#6b7280;">Event Page</p><p style="margin:6px 0 0;font-size:12px;line-height:1.5;word-break:break-all;"><a href="${eventUrl}" style="color:#0f766e;">${eventUrl}</a></p></td></tr>
            </table>
            ${event.is_online ? `<table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;"><tr><td style="padding:12px 14px;border:1px solid #bfdbfe;background:#eff6ff;border-radius:10px;"><p style="margin:0;font-size:12px;color:#1d4ed8;font-weight:700;">Meeting Access</p><p style="margin:8px 0 0;font-size:12px;color:#1e3a8a;">For security, meeting URL is protected behind AppsMagic join flow.</p><p style="margin:8px 0 0;font-size:12px;color:#1e3a8a;">Event ID: <strong>${shortEventId}</strong> • Ticket: <strong>${ticketCode}</strong></p></td></tr></table>` : ''}
            <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:14px;border:1px solid #dbeafe;background:#f8fbff;border-radius:10px;">
              <tr><td style="padding:12px 14px;">
                <p style="margin:0;font-size:12px;color:#1d4ed8;font-weight:700;">Join Instructions</p>
                <ol style="margin:8px 0 0 18px;padding:0;color:#1f2937;font-size:12px;line-height:1.55;">
                  <li>Click <strong>Join Meeting</strong> for instant join with your ticket auto-filled.</li>
                  <li>Or click <strong>Enter Ticket Manually</strong> and type Event ID + Ticket Code.</li>
                  <li>If host has not started yet, wait and retry from AppsMagic join page.</li>
                  <li>For support, reply to this email.</li>
                </ol>
              </td></tr>
            </table>
            <div style="text-align:center;margin-top:20px;">
              <a href="${joinUrl}" style="display:inline-block;background:#0f766e;color:#fff;font-size:14px;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:10px;">
                Join Meeting
              </a>
              <a href="${manualJoinUrl}" style="display:inline-block;margin-left:8px;background:#ffffff;color:#0f766e;font-size:14px;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:10px;border:1px solid #99f6e4;">
                Enter Ticket Manually
              </a>
            </div>
            <p style="margin:12px 0 0;font-size:12px;color:#6b7280;text-align:center;">Keep this email for check-in and event access.</p>
          </td>
        </tr>
        <tr>
          <td style="background:#f9fafb;padding:16px 20px;text-align:center;border-top:1px solid #e5e7eb;">
            <p style="margin:0;font-size:12px;color:#6b7280;">Sent by <a href="https://events.appsmagic.in" style="color:#0f766e;font-weight:700;">events.appsmagic.in</a></p>
          </td>
        </tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}
