require('dotenv').config();

const RESEND_API_KEY = process.env.RESEND_API_KEY;
const FROM_EMAIL = process.env.FROM_EMAIL || 'Scrabl <onboarding@resend.dev>';

async function sendWaitlistEmail(email, waitlistCode, name = 'Creator') {
    const displayName = name || 'Creator';

    const htmlBody = `
<div style="font-family: 'Helvetica Neue', Arial, sans-serif; max-width: 520px; margin: 0 auto; background: #0a0a0a; color: #f5f5f5; border-radius: 16px; overflow: hidden; border: 1px solid #1a1a1a;">
    <div style="padding: 40px 30px 20px; text-align: center;">
        <h1 style="color: #D4AF37; font-size: 32px; margin: 0 0 6px; font-weight: 800;">scrabl.</h1>
        <p style="color: #666; font-size: 12px; letter-spacing: 4px; text-transform: uppercase; margin: 0;">Craft Influence</p>
    </div>
    <div style="padding: 10px 30px 40px; text-align: center;">
        <p style="font-size: 16px; color: #ccc; margin-bottom: 28px;">Hello <strong>${displayName}</strong>, your spot has been secured.</p>
        <p style="font-size: 13px; color: #888; margin-bottom: 12px; letter-spacing: 2px; text-transform: uppercase;">Your Verification Code</p>
        <div style="background: #111; border: 2px solid #D4AF37; border-radius: 14px; padding: 24px; margin-bottom: 28px;">
            <span style="font-size: 38px; font-weight: bold; letter-spacing: 6px; color: #D4AF37; font-family: monospace;">${waitlistCode}</span>
        </div>
        <p style="font-size: 14px; color: #888; margin-bottom: 30px;">Enter this code on the waitlist page to confirm your spot.</p>
        <div style="border-top: 1px solid #222; padding-top: 24px;">
            <p style="font-size: 14px; color: #999; line-height: 1.7;">Scrabl is currently in development. You'll receive updates as new features become available and as we get closer to launch.</p>
        </div>
        <div style="margin-top: 30px;">
            <p style="color: #D4AF37; font-size: 13px; font-weight: 600; letter-spacing: 2px;">#scrabl26</p>
            <p style="color: #555; font-size: 12px; margin-top: 8px;">The Scrabl Team &mdash; <em>We Scrabl Out Stress.</em></p>
        </div>
    </div>
    <div style="background: #050505; padding: 16px 30px; text-align: center;">
        <p style="font-size: 11px; color: #444; margin: 0;">&copy; 2026 Scrabl Media Corp. &bull; You received this because you joined the Scrabl waitlist.</p>
    </div>
</div>`;

    if (!RESEND_API_KEY) {
        console.log(`[DEV] Waitlist email for ${email}`);
        console.log(`Code: ${waitlistCode}`);
        return null;
    }

    console.log(`Sending waitlist email to ${email}`);

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: FROM_EMAIL,
            to: [email],
            subject: 'Your Scrabl Verification Code',
            html: htmlBody,
            text: `Hello ${displayName},\n\nYour Scrabl verification code: ${waitlistCode}\n\nEnter this code on the waitlist page to confirm your spot.\n\n#scrabl26 - The Scrabl Team`
        })
    });

    const data = await response.json();

    if (!response.ok) {
        console.error(`Email failed for ${email}:`, data);
        throw new Error(data.message || 'Email send failed');
    }

    console.log(`Email sent to ${email}: ${data.id}`);
    return data;
}

async function sendAdminNotification(entry) {
    if (!RESEND_API_KEY) return null;

    const adminEmail = process.env.WAITLIST_NOTIFICATION_EMAIL;
    if (!adminEmail) return null;

    const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${RESEND_API_KEY}`,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            from: FROM_EMAIL,
            to: [adminEmail],
            subject: `New Scrabl waitlist signup: ${entry.email}`,
            html: `<p><strong>New waitlist signup:</strong></p><ul><li><strong>Email:</strong> ${entry.email}</li><li><strong>Name:</strong> ${entry.name || 'N/A'}</li><li><strong>Joined:</strong> ${entry.createdAt}</li></ul>`
        })
    });

    const data = await response.json();
    if (response.ok) {
        console.log(`Admin notification sent: ${data.id}`);
    }
    return data;
}

function setEmailTransport() {}

module.exports = { sendWaitlistEmail, sendAdminNotification, setEmailTransport };
