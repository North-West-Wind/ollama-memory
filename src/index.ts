import bodyParser from "body-parser";
import "dotenv/config";
import express from "express";
import * as fs from "fs";
import moment from "moment";
import fetch from "node-fetch";
const isEnglish = require("is-english");

// define types
type Prompt = {
	name?: string;
	platform?: string;
	noResponse?: boolean;
	reply?: string;
	message: string;
	images: string[];
}

type Chat = {
	role: "user" | "assistant" | "system";
	content: string;
	images?: string[];
}

// function setup
function validateRequestBody(body: any) {
	let obj: Partial<Prompt> = {};
	if (typeof body.name === "string") obj.name = body.name;
	if (typeof body.platform === "string") obj.platform = body.platform;
	if (typeof body.noResponse === "boolean") obj.noResponse = body.noResponse;
	if (typeof body.reply === "string") obj.reply = body.reply;
	if (typeof body.message === "string") obj.message = body.message;
	if (Array.isArray(body.images) && body.images.length && body.images.every((x: unknown) => typeof x === "string")) obj.images = body.images;
	if (!obj.message && !obj.images) return null;
	return obj as Prompt;
}

function validateHistory(json: any) {
	if (!Array.isArray(json)) return null;
	return json.filter(el => ["user", "assistant"].includes(el.role) && typeof el.content === "string") as Chat[];
}

// load environment variables
const MAX_HISTORY = typeof process.env.MAX_HISTORY == "number" ? process.env.MAX_HISTORY : 1000;
const SAVE_INTERVAL = typeof process.env.SAVE_INTERVAL == "number" ?  process.env.SAVE_INTERVAL : 60000; // default: 1 minute
const CACHE_REFRESH = typeof process.env.CACHE_REFRESH == "number" ? process.env.CACHE_REFRESH : 600000; // default: 10 minutes
const BANNED_STRINGS = (process.env.BANNED_STRINGS || "").split(",");
const ENGLISH_ONLY = !!process.env.ENGLISH_ONLY;
const OLLAMA = process.env.OLLAMA || "http://127.0.0.1:11434";

// define other variables
const modelHistory: { [key: string]: { role: string, content: string }[] } = {};
let modelExist: { [key: string]: boolean } = {};
const queue: { model: string, body: Prompt, res: express.Response }[] = [];
let working = false;

// setup save file directory
if (!fs.existsSync("history") || !fs.statSync("history").isDirectory()) fs.mkdirSync("history");

// express server setup
const app = express();
app.use(bodyParser.json());

app.get("/", (_req, res) => {
	res.sendStatus(200);
});

app.get("/check", (_req, res) => {
	fetch(OLLAMA).then(async response => {
		if (!response.ok || (await response.text()) != "Ollama is running") res.sendStatus(500);
		else res.sendStatus(200);
	}).catch(err => {
		res.sendStatus(500);
	});
});

app.post("/chat/:model", async (req, res) => {
	const body = validateRequestBody(req.body);
	if (!body) return res.json({ error: "Invalid request" });
	if (BANNED_STRINGS.some(str => body.message.toLowerCase().includes(str))) return res.json({ error: "Message contains banned strings" });

	queue.push({ model: req.params.model, body, res });
	if (!working) dequeue();
});

app.listen(process.env.PORT || 3000, () => console.log("Listening at port " + process.env.PORT || 3000));

// dequeue function
async function dequeue() {
	console.log("Dequeuing...");
	working = true;
	const { model, body, res } = queue.shift()!;

	if (!modelHistory[model]) {
		if (!fs.existsSync("history/" + model + ".json"))
			modelHistory[model] = [];
		else {
			try {
				const content = fs.readFileSync("history/" + model + ".json", { encoding: "utf8" });
				const json = JSON.parse(content);
				modelHistory[model] = validateHistory(json) || [];
				console.log(`Loaded ${modelHistory[model].length} messages for model ${model}`);
			} catch (err) {
				console.error(err);
				modelHistory[model] = [];
			}
		}
	}

	if (modelHistory[model].length > MAX_HISTORY) modelHistory[model].splice(0, modelHistory[model].length - MAX_HISTORY);

	let skip = false;
	let message = body.message, from = "en";
	if (ENGLISH_ONLY && !isEnglish(message)) {
		try {
			const translate = await fetch(`https://www.northwestw.in/translate?in=${encodeURIComponent(message)}&deepl=1`);
			if (!translate.ok) {
				skip = true;
				res.json({ error: "Translation failed" });
			} else {
				const json = await translate.json();
				message = json.out || message;
				from = json.lang || from;
			}
		} catch (err) {
			console.error(err);
			skip = true;
			res.json({ error: "Translation failed" });
		}
	}

	let content = "";
	content += `Current time: ${moment().format("HH:mm:ss Do MMMM YYYY")}; `;
	content += `Platform: ${body.platform || "Unknown"}; `;
	content += `Message from ${body.name || "Unknown"}; `
	if (from != "en") content += `Message translated from ${from}; `;
	if (body.reply) content += `In reply to:\n${body.reply}`;
	content += `\n\nMessage:\n${message}`;
	modelHistory[model].push(Object.assign({ role: "user", content }, body.images ? { images: body.images } : {}));

	if (!skip) {
		if (modelExist[model] === undefined) {
			try {
				const checkModel = await fetch(OLLAMA + "/api/show", { method: "POST", headers: { 'Content-Type': "application/json" }, body: JSON.stringify({ name: model }) });
				if (!checkModel.ok) {
					skip = true;
					res.json({ error: "Invalid model " + model });
				} else modelExist[model] = true;
			} catch (err) {
				skip = true;
				console.error(err);
				res.json({ error: err });
			}
		} else if (!modelExist[model]) {
			skip = true;
			res.json({ error: "Invalid model " + model });
		}
	}

	if (!skip) {
		if (body.noResponse) {
			res.json({ done: true });
		} else {
			try {
				const chat = await fetch(OLLAMA + "/api/chat", { method: "POST", headers: { 'Content-Type': "application/json" }, body: JSON.stringify({ model: model, messages: modelHistory[model], stream: false }) });
				if (!chat.ok) res.json({ error: "Ollama error " + chat.status });
				else {
					const response = (await chat.json()) as { message: Chat };
					res.json(response);
					modelHistory[model].push(response.message);
					console.log("Prompt processed successfully.");
				}
			} catch (err) {
				res.json({ error: "Server error " + err });
			}
		}
	}

	if (queue.length) dequeue();
	else working = false;
}

// history save timer
setInterval(() => {
	for (const model in modelHistory)
		fs.writeFileSync("history/" + model + ".json", JSON.stringify(modelHistory[model]));
}, SAVE_INTERVAL);

// cache refresh timer
setInterval(() => {
	modelExist = {};
}, CACHE_REFRESH);