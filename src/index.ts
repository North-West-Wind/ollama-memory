import bodyParser from "body-parser";
import "dotenv/config";
import express from "express";
import * as fs from "fs";
import moment from "moment";
import fetch from "node-fetch";
import { exit } from "process";

const MAX_HISTORY = typeof process.env.MAX_HISTORY == "number" ? process.env.MAX_HISTORY : 1000;
const SAVE_INTERVAL = typeof process.env.SAVE_INTERVAL == "number" ?  process.env.SAVE_INTERVAL : 60000;
const OLLAMA = process.env.OLLAMA || "http://127.0.0.1:11434";
fetch(OLLAMA).then(async res => {
	if (!res.ok || (await res.text()) != "Ollama is running") {
		console.error("Invalid Ollama API URL");
	}
}).catch(err => {
	console.error(err);
});

if (!fs.existsSync("history") || !fs.statSync("history").isDirectory()) fs.mkdirSync("history");

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

type Prompt = {
	name?: string;
	platform?: string;
	message: string;
	noResponse?: boolean;
}

type Chat = {
	role: "user" | "assistant";
	content: string;
}

function validateRequestBody(body: any) {
	if (typeof body.message !== "string") return null;
	let obj = { message: body.message };
	if (typeof body.name === "string") obj = Object.assign(obj, { name: body.name });
	if (typeof body.platform === "string") obj = Object.assign(obj, { platform: body.platform });
	if (typeof body.noResponse === "boolean") obj = Object.assign(obj, { noResponse: body.noResponse });
	return obj as Prompt;
}

function validateHistory(json: any) {
	if (!Array.isArray(json)) return null;
	return json.filter(el => ["user", "assistant"].includes(el.role) && typeof el.content === "string") as Chat[];
}

const modelHistory: { [key: string]: { role: string, content: string }[] } = {};

app.post("/chat/:model", async (req, res) => {
	const body = validateRequestBody(req.body);
	if (!body) return res.json({ error: "Invalid request" });

	if (!modelHistory[req.params.model]) {
		if (!fs.existsSync("history/" + req.params.model + ".json"))
			modelHistory[req.params.model] = [];
		else {
			try {
				const content = fs.readFileSync("history/" + req.params.model + ".json", { encoding: "utf8" });
				const json = JSON.parse(content);
				modelHistory[req.params.model] = validateHistory(json) || [];
			} catch (err) {
				console.error(err);
				modelHistory[req.params.model] = [];
			}
		}
	}

	if (modelHistory[req.params.model].length > MAX_HISTORY) modelHistory[req.params.model].splice(0, modelHistory[req.params.model].length - MAX_HISTORY);
	modelHistory[req.params.model].push({ role: "user", content: `Current time: ${moment().format("HH:mm:ss Do MMMM YYYY")}; Platform: ${body.platform || "Unknown"}; Sender: ${body.name || "Unknown"}; Message:\n${body.message}` });

	try {
		const checkModel = await fetch(OLLAMA + "/api/show", { method: "POST", headers: { 'Content-Type': "application/json" }, body: JSON.stringify({ name: req.params.model }) });
		if (!checkModel.ok) return res.json({ error: "Invalid model " + req.params.model });
	} catch (err) {
		console.error(err);
		return res.json({ error: err });
	}

	if (body.noResponse) {
		res.json({ done: true });
	} else {
		try {
			const chat = await fetch(OLLAMA + "/api/chat", { method: "POST", headers: { 'Content-Type': "application/json" }, body: JSON.stringify({ model: req.params.model, messages: modelHistory[req.params.model], stream: false }) });
			if (!chat.ok) res.json({ error: "Ollama error " + chat.status });
			else {
				const response = (await chat.json()) as { message: Chat };
				res.json(response);
				modelHistory[req.params.model].push(response.message);
			}
		} catch (err) {
			res.json({ error: "Server error " + err });
		}
	}
});

// save timer
setInterval(() => {
	for (const model in modelHistory)
		fs.writeFileSync("history/" + model + ".json", JSON.stringify(modelHistory[model]));
}, SAVE_INTERVAL);

app.listen(process.env.PORT || 3000, () => console.log("Listening at port " + process.env.PORT || 3000));