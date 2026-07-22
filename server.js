const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const mongoose = require('mongoose');
const { GoogleGenerativeAI } = require('@google/generative-ai');
require('dotenv').config();
const { sendWaitlistEmail, sendAdminNotification, setEmailTransport } = require('./emailService');

const app = express();
const PORT = process.env.PORT || 5500;

app.use(express.static(path.join(__dirname)));

// Initialize Gemini client with API key
let geminiClient = null;
let geminiInitError = null;
try {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
    if (apiKey) {
        const genAI = new GoogleGenerativeAI(apiKey);
        geminiClient = genAI.getGenerativeModel({ model: geminiModel });
        console.log(`✅ Gemini client initialized with API key and model: ${geminiModel}`);
    } else {
        geminiInitError = 'Gemini API key not found. Add GOOGLE_API_KEY or GEMINI_API_KEY to your .env file.';
        console.warn('⚠️  Gemini API key not found. Add GOOGLE_API_KEY or GEMINI_API_KEY to your .env file.');
        console.warn('Get your API key from: https://makersuite.google.com/app/apikey');
    }
} catch (error) {
    geminiInitError = error.message || 'Failed to initialize Gemini client.';
    console.warn('⚠️  Failed to initialize Gemini client:', geminiInitError);
}

// Middleware
app.use(cors({
  origin: [
    'http://localhost:5500',
    'http://localhost:5000',
    'http://127.0.0.1:5500',
    'https://scrabl.com',
    'https://www.scrabl.com',
    'https://ahceed.github.io'
  ],
  credentials: true
}));
app.use(express.json());

// ========== IN-MEMORY STORAGE (auth - kept for now) ==========
const users = new Map();
const otpStore = new Map();

// Helper: Generate 6-digit OTP
function generateOTP() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

function generateWaitlistCode() {
    return `SCRABL-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

// ========== MONGODB CONNECTION ==========
const MONGO_URI = process.env.MONGO_URI;
if (MONGO_URI) {
    mongoose.connect(MONGO_URI, { dbName: 'scrabl' })
        .then(() => console.log('✅ MongoDB Atlas connected'))
        .catch(err => console.error('❌ MongoDB connection error:', err.message));
} else {
    console.warn('⚠️  MONGO_URI not set in .env — waitlist will NOT work');
}

// Waitlist Schema + Model
const waitlistSchema = new mongoose.Schema({
    name:        { type: String, default: '' },
    email:       { type: String, required: true, unique: true, lowercase: true, trim: true },
    waitlistCode: { type: String },
    verified:    { type: Boolean, default: false },
    source:      { type: String, default: 'waitlist-page' },
    createdAt:   { type: Date, default: Date.now },
    confirmedAt: { type: Date }
});
const WaitlistEntry = mongoose.model('WaitlistEntry', waitlistSchema);

// ========== EMAIL TRANSPORT (Gmail SMTP) ==========
let emailTransport = null;
let emailTransportReady = false;

const SMTP_EMAIL = process.env.SMTP_EMAIL;
const SMTP_PASSWORD = process.env.SMTP_PASSWORD;

if (SMTP_EMAIL && SMTP_PASSWORD) {
    emailTransport = nodemailer.createTransport({
        host: 'smtp.gmail.com',
        port: 587,
        secure: false,
        auth: { user: SMTP_EMAIL, pass: SMTP_PASSWORD }
    });
} else {
    console.warn('⚠️  SMTP_EMAIL / SMTP_PASSWORD not set — emails will only log to console');
}

function sendEmailWithOTP(email, otp) {
    const rawMessage = {
        from: `"scrabl." <${SMTP_EMAIL || 'no-reply@scrabl.ai'}>`,
        to: email,
        subject: 'Your Scrabl verification code',
        text: `Your Scrabl verification code is ${otp}. It expires in 10 minutes.`,
        html: `<p>Your Scrabl verification code is <strong>${otp}</strong>.</p><p>It expires in 10 minutes.</p>`
    };

    if (emailTransportReady && emailTransport) {
        emailTransport.sendMail(rawMessage).catch(() => {});
    } else {
        console.log(`✉️  EMAIL SENT TO: ${email}`);
        console.log(`🔐 OTP CODE: ${otp}`);
        console.log(`⏱️  Valid for 10 minutes\n`);
    }
}

async function notifyWaitlistSignup(entry) {
    try {
        await sendWaitlistEmail(entry.email, entry.waitlistCode, entry.name);
        if (process.env.WAITLIST_NOTIFICATION_EMAIL) {
            await sendAdminNotification(entry);
        }
        return true;
    } catch (err) {
        console.warn('⚠️ Waitlist email failed:', err?.message || err);
        throw err;
    }
}

function normalizeSectionItems(value) {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value.flatMap(item => {
            if (typeof item === 'string' || typeof item === 'number') {
                return String(item).trim();
            }
            if (item && typeof item === 'object') {
                if (typeof item.text === 'string') return item.text.trim();
                if (typeof item.signal === 'string') return item.signal.trim();
                if (typeof item.hook === 'string') return item.hook.trim();
                if (typeof item.description === 'string') return item.description.trim();
                if (typeof item.strategy === 'string') return item.strategy.trim();
                if (Array.isArray(item.hashtags)) return normalizeSectionItems(item.hashtags);
                return Object.values(item)
                    .filter(v => typeof v === 'string' || typeof v === 'number')
                    .map(String)
                    .map(str => str.trim())
                    .filter(Boolean);
            }
            return [];
        }).filter(Boolean);
    }
    if (typeof value === 'string') return value.split(/\r?\n/).map(item => item.trim()).filter(Boolean);
    return [];
}

async function extractGeminiRawText(result) {
    const response = result?.response;
    if (!response) return '';

    const candidate = response?.candidates?.[0];
    const content = candidate?.content;
    if (content) {
        if (Array.isArray(content.parts)) {
            return content.parts.map(part => String(part.text || '')).join('').trim();
        }
        if (typeof content.text === 'string') {
            return content.text.trim();
        }
    }

    if (typeof response.text === 'function') {
        try {
            const text = await response.text();
            return String(text || '').trim();
        } catch (e) {
            return '';
        }
    }

    if (typeof response === 'string') {
        return response.trim();
    }

    return '';
}

function parseGeminiResponse(raw) {
    const parsed = { hooks: [], description: [], strategy: [], hashtags: [] };
    if (!raw) return parsed;

    const cleaned = raw.replace(/[\u2028\u2029]/g, '').trim();
    const codeBlockMatch = cleaned.match(/```(?:json(?:\r?\n)?)?([\s\S]*?)```/i);
    const payload = codeBlockMatch ? codeBlockMatch[1].trim() : cleaned;

    try {
        const json = JSON.parse(payload);

        if (Array.isArray(json)) {
            json.forEach(item => {
                if (item.hook || item.signal) parsed.hooks.push(String(item.hook || item.signal).trim());
                if (item.description) parsed.description.push(String(item.description).trim());
                if (item.strategy) parsed.strategy.push(String(item.strategy).trim());
                if (item.hashtags) {
                    normalizeSectionItems(item.hashtags).forEach(tag => {
                        parsed.hashtags.push(tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`);
                    });
                }
            });
            return parsed;
        }

        parsed.hooks = normalizeSectionItems(json.hooks || json.signals);
        parsed.description = normalizeSectionItems(json.description || json.descriptions);
        parsed.strategy = normalizeSectionItems(json.strategy || json.strategies);
        parsed.hashtags = normalizeSectionItems(json.hashtags).map(tag => tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`);
        return parsed;
    } catch (err) {
        let section = null;
        const lines = cleaned.split(/\r?\n/).map(line => line.trim()).filter(Boolean);

        lines.forEach((line) => {
            const lower = line.toLowerCase();
            if (/^\[?hooks?\]?[:\-]?/.test(lower) || /^\[?signals?\]?[:\-]?/.test(lower)) {
                section = 'hooks';
                return;
            }
            if (/^\[?description[s]?\]?[:\-]?/.test(lower)) {
                section = 'description';
                return;
            }
            if (/^\[?strategy\]?[:\-]?/.test(lower)) {
                section = 'strategy';
                return;
            }
            if (/^\[?hashtags?\]?[:\-]?/.test(lower)) {
                section = 'hashtags';
                return;
            }

            if (section === 'hashtags') {
                normalizeSectionItems(line).forEach(tag => {
                    parsed.hashtags.push(tag.startsWith('#') ? tag : `#${tag.replace(/^#+/, '')}`);
                });
            } else if (section) {
                parsed[section].push(line.replace(/^[\-•\d\.\)\s]+/, '').trim());
            }
        });

        parsed.hashtags = parsed.hashtags.slice(0, 7);
        return parsed;
    }
}

// ========== SIGNUP ENDPOINT ==========
app.post('/api/auth/signup', async (req, res) => {
    const { name, email, password } = req.body;

    // Validation
    if (!name || !email || !password) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    if (password.length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Invalid email format' });
    }

    // Check if user already exists
    if (users.has(email)) {
        return res.status(409).json({ error: 'Email already registered' });
    }

    // Generate OTP and store temporarily
    const otp = generateOTP();
    otpStore.set(email, { otp, createdAt: Date.now(), name, password });

    // Send OTP via email
    sendEmailWithOTP(email, otp);

    return res.status(200).json({ 
        message: 'OTP sent to email',
        email: email
    });
});

// ========== VERIFY OTP ENDPOINT ==========
app.post('/api/auth/verify', async (req, res) => {
    const { email, otp } = req.body;

    // Validation
    if (!email || !otp) {
        return res.status(400).json({ error: 'Email and OTP required' });
    }

    // Check if OTP exists
    if (!otpStore.has(email)) {
        return res.status(400).json({ error: 'No verification code found. Please sign up again.' });
    }

    const storedData = otpStore.get(email);
    const { otp: storedOTP, createdAt, name, password } = storedData;

    // Check if OTP is expired (10 minutes)
    if (Date.now() - createdAt > 10 * 60 * 1000) {
        otpStore.delete(email);
        return res.status(400).json({ error: 'OTP expired. Please request a new code.' });
    }

    // Verify OTP
    if (otp !== storedOTP) {
        return res.status(400).json({ error: 'Invalid OTP code' });
    }

    // OTP correct - create user account
    users.set(email, { name, email, password, createdAt: new Date(), preferences: storedData.preferences || {} });
    otpStore.delete(email); // Remove used OTP

    return res.status(200).json({ 
        message: 'Account created successfully',
        user: { name, email, createdAt: new Date() }
    });
});

// ========== RESEND OTP ENDPOINT ==========
app.post('/api/auth/resend', async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }

    if (!otpStore.has(email)) {
        return res.status(400).json({ error: 'No pending verification for this email' });
    }

    // Generate new OTP
    const otp = generateOTP();
    const storedData = otpStore.get(email);
    otpStore.set(email, { ...storedData, otp, createdAt: Date.now() });

    // Send new OTP
    sendEmailWithOTP(email, otp);

    return res.status(200).json({ message: 'New OTP sent to email' });
});

// ========== LOGIN ENDPOINT ==========
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;

    // Validation
    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password required' });
    }

    // Check if user exists
    if (!users.has(email)) {
        return res.status(401).json({ error: 'Invalid email or password' });
    }

    const user = users.get(email);
    
    // Check password (in production, use proper password hashing)
    if (user.password !== password) {
        return res.status(401).json({ error: 'Invalid email or password' });
    }

    return res.status(200).json({ 
        message: 'Login successful',
        user: { name: user.name, email: user.email, createdAt: user.createdAt }
    });
});

// ========== GET USER PREFERENCES ==========
app.get('/api/user/preferences', (req, res) => {
    const { email } = req.query;

    if (!email) {
        return res.status(400).json({ error: 'Email required' });
    }

    if (!users.has(email)) {
        return res.status(404).json({ error: 'User not found' });
    }

    const user = users.get(email);
    return res.status(200).json({ preferences: user.preferences || {} });
});

// ========== UPDATE USER PREFERENCES ==========
app.post('/api/user/preferences', (req, res) => {
    const { email, preferences } = req.body;

    if (!email || !preferences) {
        return res.status(400).json({ error: 'Email and preferences required' });
    }

    if (!users.has(email)) {
        return res.status(404).json({ error: 'User not found' });
    }

    const user = users.get(email);
    user.preferences = preferences;
    users.set(email, user);

    return res.status(200).json({ 
        message: 'Preferences updated successfully',
        preferences: user.preferences
    });
});

// ========== GEMINI PROXY ENDPOINT ==========
app.post('/api/gemini/generate', async (req, res) => {
    if (!geminiClient) {
        const message = geminiInitError || 'Gemini client not initialized. Check GOOGLE_API_KEY in .env.';
        return res.status(500).json({ error: message });
    }

    const { directionText = '', ocrText = '', selectedVibe = '', voicePreview = '', systemPrompt = '', userPrompt = '' } = req.body;
    const payloadPrompt = systemPrompt || `You are the Scrabl Lagos Gold intelligence engine. Create premium, minimalist, authoritative copy for elite creators. Use an elevated tone, concise structure, and present content in a sharp, confident voice.`;
    const prompt = `${payloadPrompt}\n\n${userPrompt}`;

    try {
        const result = await geminiClient.generateContent(prompt);
        let rawText = await extractGeminiRawText(result);

        if (!rawText) {
            rawText = result?.response?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('').trim() || '';
        }

        const sections = parseGeminiResponse(rawText);

        if (!sections.hooks.length && !sections.description.length && !sections.hashtags.length) {
            return res.status(500).json({ error: 'Gemini returned no structured content.', rawText });
        }

        return res.json({ sections, rawText });
    } catch (error) {
        console.error('Gemini proxy error:', error);

        // Handle rate limits and invalid API key states
        const errMsg = error.message || '';
        if (errMsg.toLowerCase().includes('expired') || errMsg.toLowerCase().includes('invalid')) {
            return res.status(401).json({ error: 'Gemini API key expired or invalid. Renew the key in your .env and restart the backend.' });
        }
        if (error.status === 429 || errMsg.toLowerCase().includes('rate limit')) {
            return res.status(429).json({ error: 'Rate limit exceeded. Please try again later.' });
        }

        return res.status(500).json({ error: errMsg || 'Gemini proxy failure' });
    }
});

// ========== SIMPLE LOCAL STUB GENERATE ENDPOINT ==========
// This lightweight endpoint allows frontend testing without Gemini.
app.post('/api/generate', (req, res) => {
    const { userPrompt = '' } = req.body || {};
    const sampleRaw = `[[HOOKS]]\n- Quick hook 1\n- Quick hook 2\n\n[[DESCRIPTION]]\nA short, high-retention caption generated for testing.\n\n[[STRATEGY]]\nUse short punchy lines and a CTA.\n\n[[HASHTAGS]]\n#test #scrabl`;
    const sampleSections = {
        hooks: ['Quick hook 1', 'Quick hook 2', 'Quick hook 3'],
        description: ['A short, high-retention caption generated for testing.'],
        strategy: ['Use short punchy lines and a CTA.'],
        hashtags: ['#test', '#scrabl']
    };
    console.log('[/api/generate] stub invoked, prompt length:', (userPrompt || '').length);
    return res.json({ rawText: sampleRaw, sections: sampleSections });
});

// ========== WAITLIST SIGNUP ENDPOINT ==========
app.post('/api/waitlist', async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const name = (req.body?.name || '').trim();

    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    try {
        const existing = await WaitlistEntry.findOne({ email });

        if (existing && existing.verified) {
            return res.status(409).json({ error: "You're already on the waitlist! We'll be in touch soon." });
        }

        const waitlistCode = generateWaitlistCode();

        if (existing) {
            // Resend code to unverified user
            existing.waitlistCode = waitlistCode;
            existing.name = name || existing.name;
            await existing.save();
        } else {
            await WaitlistEntry.create({ email, name, waitlistCode, source: req.body?.source || 'waitlist-page' });
        }

        console.log(`✉️ Waitlist signup: ${email} | Code: ${waitlistCode}`);

        // Send email (don't block response if email fails in dev)
        try {
            await notifyWaitlistSignup({ email, waitlistCode, name, createdAt: new Date().toISOString() });
        } catch (emailErr) {
            console.warn('⚠️ Email send failed but signup saved:', emailErr?.message);
            // In dev mode without SMTP, the code is logged to console
        }

        return res.json({ message: 'Verification code sent! Check your email.', email });
    } catch (err) {
        console.error('Waitlist signup error:', err);
        if (err.code === 11000) {
            return res.status(409).json({ error: 'This email is already registered.' });
        }
        return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    }
});

// ========== WAITLIST CODE VERIFICATION ==========
app.post('/api/waitlist/verify', async (req, res) => {
    const email = (req.body?.email || '').trim().toLowerCase();
    const code = (req.body?.code || '').trim();

    if (!email || !code) {
        return res.status(400).json({ error: 'Email and code are required.' });
    }

    try {
        const entry = await WaitlistEntry.findOne({ email });

        if (!entry) {
            return res.status(404).json({ error: 'No signup found for this email. Please sign up first.' });
        }

        if (entry.verified) {
            return res.status(200).json({ message: "Already verified — you're on the list!" });
        }

        if (entry.waitlistCode !== code) {
            return res.status(400).json({ error: 'Wrong code. Please check your email and try again.' });
        }

        entry.verified = true;
        entry.confirmedAt = new Date();
        entry.waitlistCode = undefined;
        await entry.save();

        console.log(`🎉 Waitlist verified: ${email}`);
        return res.json({ message: "You're in! Welcome to the Scrabl waitlist." });
    } catch (err) {
        console.error('Waitlist verify error:', err);
        return res.status(500).json({ error: 'Verification failed. Please try again.' });
    }
});

// ========== HEALTH CHECK ==========
app.get('/api/health', (req, res) => {
    res.json({ status: 'Scrabl Backend is running ✨' });
});

async function startServer() {
    const server = app.listen(PORT, () => {
        console.log(`\n🚀 Scrabl Backend running on http://localhost:${PORT}`);
        console.log(`📝 OTP codes logged to console in dev mode\n`);
    });

    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            console.error(`\n⚠️  Port ${PORT} is already in use.`);
            process.exit(1);
        }
        throw err;
    });

    if (emailTransport) {
        setEmailTransport(emailTransport);
        try {
            await emailTransport.verify();
            emailTransportReady = true;
            console.log('✅ Gmail SMTP verified and ready');
        } catch (err) {
            console.warn('⚠️ SMTP verification failed:', err.message);
            console.warn('   Waitlist emails will still be attempted on send');
            emailTransportReady = true;
        }
    }
}
startServer();
