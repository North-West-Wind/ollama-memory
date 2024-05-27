# ollama-memory
Make Ollama models remember what they talked about.

This is basically an API wrapper for Ollama, with additional file management for storing previous chats. It currently only supports the `/api/chat` endpoint.

## Usage
Clone this repository, and run `npm install`.  
Run `npm test` to start it.

You can configure the environment variables prior to starting it.
```bash
MAX_HISTORY=1000 # Maximum chat history to keep (includes both user and assistant)
SAVE_INTERVAL=60000 # Interval between saving in-memory chat history to files
OLLAMA=http://127.0.0.1:11434 # Ollama API root URL
PORT=3000 # Port to run this program
```

To communicate with a model, use the `/chat/:model` endpoint (replace `:model` with an existing model).  
Make a `POST` request with the following body:
```json
{
	"message": "(required) the prompt",
	"name": "(optional) your name",
	"platform": "(optional) a communication platform, like matrix, discord, twitch",
	"noResponse": false
}
```
Setting `noResponse` to `true` will only add the message to the history, but the AI won't respond.

Remember to also set header with `Content-Type: application/json` or otherwise the API won't accept it.