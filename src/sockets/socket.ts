import cron from "node-cron"
import { v4 as uuidv4 } from "uuid"
import OpenAI from "openai"
import { Server, Socket } from "socket.io"
import { Pool } from "pg"

// ── OpenAI / Groq client ─────────────────────────────────────────────────────
const client = new OpenAI({
    apiKey: process.env.GROK_API_KEY,
    baseURL: "https://api.groq.com/openai/v1",
})

// ── DB injection ─────────────────────────────────────────────────────────────
let db: Pool

export function setDb(pool: Pool) {
    db = pool
}

// ── Types ────────────────────────────────────────────────────────────────────
interface SendMessageData {
    msg: string
    chatId?: string
}

interface GetSuggestionsData {
    category: string
}

interface MessageRow {
    question: string
    answer: string
}

// ── FAQ cache with TTL (1 hour) ──────────────────────────────────────────────
const FAQ_TTL_MS = 60 * 60 * 1000

let faqCache: string | null = null
let faqCacheExpiry = 0

async function loadFAQ(): Promise<string> {
    if (faqCache && Date.now() < faqCacheExpiry) return faqCache

    const result = await db.query<MessageRow>(
        "SELECT question, answer FROM faq"
    )
    faqCache = result.rows
        .map((r: MessageRow) => `Q: ${r.question}\nA: ${r.answer}`)
        .join("\n\n")
    faqCacheExpiry = Date.now() + FAQ_TTL_MS
    console.log(`✅ FAQ cached: ${result.rows.length} entries (expires in 1h)`)
    return faqCache!
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function generateTitle(msg: string): string {
    const words = msg.trim().split(/\s+/).slice(0, 5).join(" ")
    return words.length > 40 ? words.substring(0, 40) + "..." : words
}

function sanitize(msg: string): string {
    return msg.trim().slice(0, 2000)
}

// ── AI ───────────────────────────────────────────────────────────────────────
async function askGrok(
    userMessage: string,
    faqContext: string,
    history: MessageRow[]
): Promise<string> {
    const systemPrompt = `You are a helpful, friendly assistant named Ultron.

Your job is to answer the user's question using the knowledge base below as your PRIMARY source of truth.

RULES:
1. If the answer exists in the knowledge base, USE that answer as your base — but rewrite it naturally and engagingly. Do NOT copy it word for word.
2. Expand slightly if it adds clarity, but stay concise and on-point.
3. If the knowledge base has no relevant answer, use your general knowledge to help.
4. Never say "according to the knowledge base" or "based on the FAQ" — just answer naturally.
5. Use simple formatting if helpful: short paragraphs, or a brief list if there are multiple points.
6. Keep a friendly, conversational tone — like a knowledgeable friend, not a robot.
7. Do NOT use markdown headers (##, ###). Avoid excessive bold. Keep it clean and readable.

--- KNOWLEDGE BASE ---
${faqContext}
--- END OF KNOWLEDGE BASE ---`

    const historyMessages = history.flatMap((m) => [
        { role: "user" as const, content: m.question },
        { role: "assistant" as const, content: m.answer },
    ])

    const completion = await client.chat.completions.create({
        model: "llama-3.1-8b-instant",
        messages: [
            { role: "system", content: systemPrompt },
            ...historyMessages,
            { role: "user", content: userMessage },
        ],
        max_tokens: 600,
        temperature: 0.75,
    })

    return completion.choices[0].message.content?.trim() ?? ""
}

// ── Cron: daily cleanup ───────────────────────────────────────────────────────
cron.schedule(
    "0 0 * * *",
    async () => {
        console.log("🕛 Running daily chat cleanup...")
        try {
            await db.query("DELETE FROM messages")
            await db.query("DELETE FROM chats")
            faqCache = null
            faqCacheExpiry = 0
            console.log("✅ Chats and messages cleared")
        } catch (err) {
            console.error("❌ Chat cleanup error:", (err as Error).message)
        }
    },
    { timezone: "Asia/Kolkata" }
)

// ── Socket handler ────────────────────────────────────────────────────────────
export function socketHandler(io: Server): void {
    io.on("connection", (socket: Socket) => {
        console.log("✅ User connected:", socket.id)

        /* ── GET SUGGESTIONS BY CATEGORY ── */
        socket.on("get_suggestions", async ({ category }: GetSuggestionsData) => {
            if (!category) return
            try {
                const result = await db.query<{ question: string }>(
                    `SELECT question FROM faq WHERE category = $1`,
                    [category]
                )
                socket.emit("suggestions", {
                    questions: result.rows.map((r: { question: string }) => r.question),
                })
            } catch (err) {
                console.error("❌ get_suggestions error:", (err as Error).message)
                socket.emit("suggestions", { questions: [] })
            }
        })

        /* ── SEND MESSAGE ── */
        socket.on("send_message", async ({ msg, chatId }: SendMessageData) => {
            const cleanMsg = sanitize(msg ?? "")
            if (!cleanMsg) return

            const conn = await db.connect()
            try {
                const [faqContext, historyRows] = await Promise.all([
                    loadFAQ(),
                    chatId
                        ? db.query<MessageRow>(
                            `SELECT question, answer FROM messages
                               WHERE chat_id = $1 ORDER BY id DESC LIMIT 10`,
                            [chatId]
                        ).then((r: { rows: MessageRow[] }) => r.rows)
                        : Promise.resolve([] as MessageRow[]),
                ])

                const history = [...historyRows].reverse()
                const response = await askGrok(cleanMsg, faqContext, history)

                await conn.query("BEGIN")

                if (!chatId) {
                    const newChatId = uuidv4()
                    const title = generateTitle(cleanMsg)

                    await conn.query(
                        `INSERT INTO chats (id, title) VALUES ($1, $2)`,
                        [newChatId, title]
                    )
                    await conn.query(
                        `INSERT INTO messages (chat_id, question, answer) VALUES ($1, $2, $3)`,
                        [newChatId, cleanMsg, response]
                    )
                    await conn.query("COMMIT")

                    socket.emit("receive_message", {
                        chatId: newChatId,
                        question: cleanMsg,
                        answer: response,
                    })
                } else {
                    await conn.query(
                        `INSERT INTO messages (chat_id, question, answer) VALUES ($1, $2, $3)`,
                        [chatId, cleanMsg, response]
                    )
                    await conn.query("COMMIT")

                    socket.emit("receive_message", {
                        chatId,
                        question: cleanMsg,
                        answer: response,
                    })
                }
            } catch (err) {
                await conn.query("ROLLBACK").catch(() => { })
                console.error("❌ send_message error:", (err as Error).message)
                socket.emit("receive_message", {
                    chatId,
                    question: msg,
                    answer: "Sorry, I'm having trouble right now. Please try again.",
                })
            } finally {
                conn.release()
            }
        })

        socket.on("disconnect", () => {
            console.log("❌ User disconnected:", socket.id)
        })
    })
}
