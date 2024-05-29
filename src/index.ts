import bodyParser from "body-parser";
import "dotenv/config";
import express from "express";
import * as fs from "fs";
import moment from "moment";
import fetch from "node-fetch";

// define types
type Prompt = {
	name?: string;
	platform?: string;
	message: string;
	noResponse?: boolean;
	images?: string[];
}

type Chat = {
	role: "user" | "assistant";
	content: string;
}

// function setup
function validateRequestBody(body: any) {
	if (typeof body.message !== "string") return null;
	let obj = { message: body.message };
	if (typeof body.name === "string") obj = Object.assign(obj, { name: body.name });
	if (typeof body.platform === "string") obj = Object.assign(obj, { platform: body.platform });
	if (typeof body.noResponse === "boolean") obj = Object.assign(obj, { noResponse: body.noResponse });
	if (Array.isArray(body.images) && body.images.every((x: unknown) => typeof x === "string")) obj = Object.assign(obj, { images: body.images });
	return obj as Prompt;
}

function validateHistory(json: any) {
	if (!Array.isArray(json)) return null;
	return json.filter(el => ["user", "assistant"].includes(el.role) && typeof el.content === "string") as Chat[];
}

// load environment variables
const MAX_HISTORY = typeof process.env.MAX_HISTORY == "number" ? process.env.MAX_HISTORY : 1000;
const SAVE_INTERVAL = typeof process.env.SAVE_INTERVAL == "number" ?  process.env.SAVE_INTERVAL : 60000;
const CACHE_REFRESH = typeof process.env.CACHE_REFRESH == "number" ? process.env.CACHE_REFRESH : 60000;
const BANNED_STRINGS = (process.env.BANNED_STRINGS || "").split(",");
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
	modelHistory[model].push(Object.assign({ role: "user", content: `Current time: ${moment().format("HH:mm:ss Do MMMM YYYY")}; Platform: ${body.platform || "Unknown"}; Sender: ${body.name || "Unknown"}; Message:\n${body.message}` }, body.images ? { images: body.images } : {}));

	let skip = false;
	try {
		const checkModel = await fetch(OLLAMA + "/api/show", { method: "POST", headers: { 'Content-Type': "application/json" }, body: JSON.stringify({ name: model }) });
		if (!checkModel.ok) {
			skip = true;
			res.json({ error: "Invalid model " + model });
		}
	} catch (err) {
		skip = true;
		console.error(err);
		res.json({ error: err });
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