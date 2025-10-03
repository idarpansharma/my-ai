import os
import re
import json
import uuid 
from flask import Flask, render_template, request, jsonify, redirect, url_for, session, send_from_directory
from flask import Response, stream_with_context
from google_auth_oauthlib.flow import Flow
from google.oauth2.credentials import Credentials
import agent

# --- Flask App Initialization ---
app = Flask(__name__)
if not os.path.exists('outputs'):
    os.makedirs('outputs')
app.secret_key = os.urandom(24)
os.environ['OAUTHLIB_INSECURE_TRANSPORT'] = '1'
CANCELLATION_FLAGS = {}

# --- Constants ---
TOKEN_FILE = "token.json"
CLIENT_SECRETS_FILE = 'credentials.json'
SCOPES = ["https://www.googleapis.com/auth/gmail.send", "https://www.googleapis.com/auth/calendar.events"]

# --- Helper Functions ---
def save_token(token_info):
    session['token_info'] = token_info
    try:
        with open(TOKEN_FILE, 'w') as f:
            json.dump(token_info, f)
    except Exception as e:
        print(f"Warning: Could not save token to disk: {e}")

def load_token():
    if 'token_info' in session:
        return session['token_info']
    if os.path.exists(TOKEN_FILE):
        try:
            with open(TOKEN_FILE, 'r') as f:
                token_info = json.load(f)
                session['token_info'] = token_info
                return token_info
        except Exception as e:
            print(f"Warning: Could not load token from disk: {e}")
    return None

def create_oauth_flow():
    return Flow.from_client_secrets_file(
        CLIENT_SECRETS_FILE,
        scopes=SCOPES,
        redirect_uri=url_for('oauth2callback', _external=True)
    )

# --- Main Routes ---
@app.route('/')
def index():
    """Renders login page or redirects to chat if already logged in."""
    if 'token_info' in session and load_token():
        return redirect(url_for('chat_page'))
    return render_template('login.html')

@app.route('/chat')
def chat_page():
    """Renders the main chat interface, protected."""
    if not ('token_info' in session and load_token()):
        return redirect(url_for('index'))
    return render_template('index.html')

# --- Authentication Routes ---
@app.route('/login')
def login():
    flow = create_oauth_flow()
    authorization_url, state = flow.authorization_url(prompt='consent')
    session['state'] = state
    return redirect(authorization_url)

@app.route('/logout')
def logout():
    session.pop('token_info', None)
    if os.path.exists(TOKEN_FILE):
        os.remove(TOKEN_FILE)
    return redirect(url_for('index'))

@app.route('/oauth2callback')
def oauth2callback():
    state = session.get('state')
    flow = create_oauth_flow()
    flow.fetch_token(authorization_response=request.url)
    
    credentials = flow.credentials
    token_info = {
        'token': credentials.token, 'refresh_token': credentials.refresh_token,
        'token_uri': credentials.token_uri, 'client_id': credentials.client_id,
        'client_secret': credentials.client_secret, 'scopes': credentials.scopes
    }
    save_token(token_info)
    return redirect(url_for('chat_page'))

# --- API Routes ---
@app.route('/api/cancel', methods=['POST'])
def api_cancel():
    data = request.json
    request_id = data.get('requestId')
    if request_id in CANCELLATION_FLAGS:
        CANCELLATION_FLAGS[request_id] = True
        print(f"Cancellation requested for ID: {request_id}")
        return jsonify({'status': 'cancellation-requested'}), 200
    return jsonify({'status': 'request-not-found'}), 404

# In app.py, replace the /api/chat function (around line 105) with this:

@app.route('/api/chat', methods=['POST'])
def api_chat():
    token_info = load_token()
    if not token_info:
        return jsonify({'error': 'User not authenticated'}), 401
    
    data = request.form
    prompt = data.get('prompt')
    user_name = data.get('userName')
    user_title = data.get('userTitle')
    
    history_json = data.get('history', '[]')
    try:
        chat_history = json.loads(history_json)
    except json.JSONDecodeError:
        chat_history = []

    request_id = data.get('requestId')
    if not request_id:
        # Cannot stream an error with a 400, so we return a regular JSON response
        return jsonify({'error': 'Missing requestId from client'}), 400
    
    CANCELLATION_FLAGS[request_id] = False

    file_content = None
    file_object = None
    
    if 'file' in request.files:
        file = request.files['file']
        if file.filename != '':
            file_content = agent.extract_text_from_file(file)
            file.seek(0)
            file_object = file

    if not prompt and not file_content:
        return jsonify({'error': 'Empty prompt and no file provided'}), 400

    def generate_updates():
        try:
            # Helper to format and yield messages in Server-Sent Event (SSE) format
            def send_event(event_type, data):
                payload = {'type': event_type, 'data': data}
                yield f"data: {json.dumps(payload)}\n\n"

            max_retries = 3
            failure_context = None
            original_prompt = prompt

            for attempt in range(max_retries):
                if attempt > 0:
                    yield from send_event('status', f"⚠️ Plan failed. Rethinking... (Attempt {attempt + 1}/{max_retries})")
                else:
                    yield from send_event('status', "🧠 Thinking up a plan...")

                master_plan = agent.get_agent_plan(
                    original_prompt, user_name, user_title,
                    history=chat_history, file_context=file_content, failure_context=failure_context
                )

                if (isinstance(master_plan, list) and len(master_plan) == 1 and
                    master_plan[0].get("tool") in ["conversational_response", "error"]):
                    response_text = master_plan[0].get("parameters", {}).get("response", "I'm not sure how to respond.")
                    yield from send_event('final', response_text)
                    return

                plan_succeeded = True
                step_results = []
                final_response = "Plan execution finished."
                
                for i, step in enumerate(master_plan):
                    if CANCELLATION_FLAGS.get(request_id):
                        yield from send_event('final', 'Request cancelled by user.')
                        return

                    # Update UI with the current tool being executed
                    tool_name = step.get('tool', 'unknown')
                    tool_display_name = tool_name.replace('_', ' ').title()
                    yield from send_event('status', f" টুল ব্যবহার করা হচ্ছে: {tool_display_name}...")


                    # Placeholder replacement logic (same as before)
                    params = step.get("parameters", {}).copy()
                    for key, value in params.items():
                        if isinstance(value, str):
                            matches = re.finditer(r'\$STEP_(\d+)_RESULT(\.\w+)?', value)
                            for match in reversed(list(matches)):
                                step_num = int(match.group(1))
                                if (step_num - 1) < len(step_results):
                                    prev_result = step_results[step_num - 1]
                                    # ... (rest of the placeholder logic is identical)
                                    replacement = ""
                                    if isinstance(prev_result, dict):
                                        property_name = match.group(2)
                                        if property_name:
                                            prop_key = property_name.lstrip('.')
                                            replacement = str(prev_result.get(prop_key, ''))
                                        else:
                                            replacement = str(prev_result.get('response', ''))
                                    else:
                                        replacement = str(prev_result)
                                    start, end = match.span()
                                    params[key] = params[key][:start] + replacement + params[key][end:]
                    step["parameters"] = params
                    
                    result = agent.run_agent_task_from_plan(
                        step, file_context=file_content, file_object=file_object, token_info=token_info
                    )
                    result_data = result.get("response", "")
                    response_str_check = result_data if isinstance(result_data, str) else result_data.get("response", "")
                    
                    if response_str_check.strip().startswith(("⚠️", "🚫", "An error occurred")):
                        plan_succeeded = False
                        if "AUTOMATION_BLOCKED" in response_str_check:
                            yield from send_event('status', "🤖 Browser automation blocked. Trying a new approach...")
                            failure_context = "The 'automate_browser' tool was blocked... Your new plan MUST use 'web_search'..."
                        else:
                            failure_context = f"The tool '{step.get('tool')}' failed with the error: '{response_str_check}'."
                        break

                    step_results.append(result_data)
                    final_response = response_str_check

                if plan_succeeded:
                    yield from send_event('final', final_response)
                    return
            
            error_message = f"I tried multiple approaches but was unable to complete your request. The last error was: {failure_context}"
            yield from send_event('error', error_message)

        except Exception as e:
            print(f"An unrecoverable error occurred in the agent logic: {e}")
            import traceback
            traceback.print_exc()
            yield from send_event('error', 'An internal server error occurred.')
        finally:
            if request_id in CANCELLATION_FLAGS:
                del CANCELLATION_FLAGS[request_id]

    return Response(stream_with_context(generate_updates()), mimetype='text/event-stream')
            
@app.route('/api/cancel', methods=['POST'])
@app.route('/outputs/<filename>')
def serve_screenshot(filename):
    """Serves a saved screenshot file from the 'outputs' directory."""
    return send_from_directory('outputs', filename)
if __name__ == '__main__':
    app.run(debug=True, port=8503, threaded=True)