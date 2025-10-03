function generateUUID() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
    );
}
// --- NEW: Agent Status UI Function ---
function updateAgentStatus(message) {
    const statusEl = document.getElementById('agent-status');
    if (!statusEl) return;
    const statusTextEl = statusEl.querySelector('.status-text');

    if (message) {
        statusTextEl.textContent = message;
        statusEl.style.display = 'flex';
    } else {
        statusEl.style.display = 'none';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    // --- DOM Element References ---
    const chatMessages = document.getElementById('chat-messages');
    const chatInput = document.getElementById('chat-input');
    const sendBtn = document.getElementById('send-btn');
    const stopButton = document.getElementById('stop-button');
    const newChatBtn = document.getElementById('new-chat-btn');
    const welcomeScreen = document.getElementById('welcome-screen');
    const fileInput = document.getElementById('file-input');
    const suggestionPrompts = document.querySelectorAll('.prompt');
    const logoutBtn = document.getElementById('logout-btn');
    const loginBtn = document.getElementById('login-btn');
    const welcomeText = document.getElementById('welcome-text');
    const mobileMenuBtn = document.getElementById('mobile-menu-btn');
    const sidebar = document.getElementById('sidebar');
    const mobileOverlay = document.getElementById('mobile-overlay');

    // NEW References for upload functionality
    const uploadBtn = document.getElementById('upload-btn');
    const chatInputArea = document.getElementById('chat-input-area');

    // --- State Management ---
    let uploadedFile = null;
    let currentRequestId = null;
    let chatHistory = [];
    let isTypingCancelled = false;
    let typewriterTimeoutId = null;

    function resetUIState() {
        sendBtn.disabled = false;
        chatInput.disabled = false;
        uploadBtn.disabled = false; // <-- THIS IS THE FIX
        stopButton.style.display = 'none';
        currentRequestId = null; // Important to clear this
        chatInput.focus();
    }


    // --- Check Login Status ---
    const isUserLoggedIn = !!logoutBtn;
    if (!isUserLoggedIn) {
        const profileDropdown = document.querySelector('.profile-dropdown');
        if (profileDropdown) profileDropdown.style.display = 'none';
        if (loginBtn) loginBtn.style.display = 'block';
        if (welcomeText) welcomeText.textContent = "Please log in to get started.";
    }

    // --- Core Functions ---
    function appendMessage(content, role) {
        if (welcomeScreen) {
            welcomeScreen.style.display = 'none';
            chatMessages.style.justifyContent = 'flex-start';
        }
        const messageWrapper = document.createElement('div');
        messageWrapper.classList.add('message-wrapper', `${role}-message`);

        let htmlContent = content
            .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
            .replace(/\n/g, '<br>');

        messageWrapper.innerHTML = `<div class="message-bubble"><p>${htmlContent}</p></div>`;
        chatMessages.appendChild(messageWrapper);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function showTypingIndicator() {
        let indicator = chatMessages.querySelector('.typing-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.classList.add('message-wrapper', 'assistant-message', 'typing-indicator');
            indicator.innerHTML = `<div class="message-bubble"><div class="typing-dots"><span></span><span></span><span></span></div></div>`;
            chatMessages.appendChild(indicator);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }
    }

    function removeTypingIndicator() {
        const indicator = chatMessages.querySelector('.typing-indicator');
        if (indicator) indicator.remove();
    }
    function formatAgentResponse(text) {
        // Convert markdown bold to <strong> tags
        let html = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
        // Convert newlines to <br> tags
        html = html.replace(/\n/g, '<br>');

        // Find and convert screenshot filenames to clickable links
        const screenshotRegex = /✅ Screenshot saved successfully as '(screenshot_[a-f0-9]{8}\.png)'\./;
        html = html.replace(screenshotRegex, (match, filename) => {
            return `✅ Screenshot saved successfully as <a href="/outputs/${filename}" target="_blank" rel="noopener noreferrer" class="screenshot-link">${filename}</a>.`;
        });

        return html;
    }

    function typeWriterEffect(htmlContent, element, speed, onComplete) {
        let i = 0;
        element.innerHTML = "";
        isTypingCancelled = false; // Reset cancellation flag

        function type() {
            if (isTypingCancelled) {
                element.innerHTML = htmlContent; // Instantly show full content on cancel
                if (onComplete) onComplete();
                return;
            }

            if (i < htmlContent.length) {
                const char = htmlContent[i];
                if (char === '<') {
                    // Find the closing '>' of the tag
                    const closingIndex = htmlContent.indexOf('>', i);
                    if (closingIndex !== -1) {
                        // Append the entire tag at once to render it correctly
                        element.innerHTML += htmlContent.substring(i, closingIndex + 1);
                        i = closingIndex; // Move index past the tag
                    } else {
                        element.innerHTML += char; // Malformed tag, just append the '<'
                    }
                } else {
                    element.innerHTML += char; // It's a regular character
                }

                i++;
                chatMessages.scrollTop = chatMessages.scrollHeight; // Scroll as content is added
                typewriterTimeoutId = setTimeout(type, speed);
            } else if (onComplete) {
                onComplete();
            }
        }
        type();
    }

    // Replace the entire handleSendMessage function (around line 133) with this
    async function handleSendMessage() {
        const prompt = chatInput.value.trim();
        if (!prompt && !uploadedFile) return;

        isTypingCancelled = false;
        const historyToSend = [...chatHistory];

        if (prompt) {
            appendMessage(prompt, 'user');
            chatHistory.push({ role: 'user', content: prompt });
        }
        chatInput.value = '';

        sendBtn.disabled = true;
        chatInput.disabled = true;
        uploadBtn.disabled = true;
        stopButton.style.display = 'inline-flex';
        updateAgentStatus('Agent is connecting...'); // Initial status

        currentRequestId = generateUUID();
        const formData = new FormData();
        formData.append('prompt', prompt);
        formData.append('history', JSON.stringify(historyToSend));
        formData.append('requestId', currentRequestId);
        formData.append('userName', document.getElementById('user-name').value);
        formData.append('userTitle', document.getElementById('user-title').value);
        if (uploadedFile) {
            formData.append('file', uploadedFile);
            uploadedFile = null;
        }

        try {
            const response = await fetch('/api/chat', { method: 'POST', body: formData });
            if (!response.ok) {
                const errData = await response.json();
                throw new Error(errData.error || 'An unknown network error occurred.');
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let buffer = '';

            const assistantMessageWrapper = document.createElement('div');
            assistantMessageWrapper.classList.add('message-wrapper', 'assistant-message');
            assistantMessageWrapper.innerHTML = `<div class="message-bubble"><p></p></div>`;
            let messageAppended = false;

            while (true) {
                const { value, done } = await reader.read();
                if (isTypingCancelled || done) {
                    if (!done) reader.cancel(); // Stop reading if cancelled
                    break;
                }

                buffer += decoder.decode(value, { stream: true });
                const parts = buffer.split('\n\n');
                buffer = parts.pop(); // Keep the last, possibly incomplete, part

                for (const part of parts) {
                    if (part.startsWith('data: ')) {
                        const jsonData = part.substring(6);
                        try {
                            const eventData = JSON.parse(jsonData);

                            if (eventData.type === 'status') {
                                updateAgentStatus(eventData.data);
                            } else if (eventData.type === 'final') {
                                if (!messageAppended) {
                                    chatMessages.appendChild(assistantMessageWrapper);
                                    messageAppended = true;
                                }
                                chatHistory.push({ role: 'assistant', content: eventData.data });
                                const formattedHtml = formatAgentResponse(eventData.data);
                                typeWriterEffect(formattedHtml, assistantMessageWrapper.querySelector('p'), 5, resetUIState);
                            } else if (eventData.type === 'error') {
                                appendMessage(`<strong>Error:</strong> ${eventData.data}`, 'system');
                                resetUIState();
                            }
                        } catch (e) {
                            console.error('Error parsing JSON from stream:', jsonData, e);
                        }
                    }
                }
            }
            updateAgentStatus(null); // Hide status when done
        } catch (error) {
            appendMessage(`<strong>Error:</strong> ${error.message}`, 'system');
            resetUIState();
            updateAgentStatus(null);
        }
    }

    function handleFileSelect(file) {
        if (!file) return;
        uploadedFile = file;
        appendMessage(`📄 File ready for next message: <strong>${file.name}</strong>`, 'system');
    }

    // --- Event Listeners ---
    sendBtn.addEventListener('click', handleSendMessage);
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSendMessage();
        }
    });

    stopButton.addEventListener('click', async () => {
        if (currentRequestId) {
            isTypingCancelled = true;
            clearTimeout(typewriterTimeoutId);
            removeTypingIndicator();
            fetch('/api/cancel', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requestId: currentRequestId })
            });
            resetUIState();
        }
    });

    newChatBtn.addEventListener('click', () => {
        chatMessages.innerHTML = '';
        if (welcomeScreen) welcomeScreen.style.display = 'flex';
        chatMessages.style.justifyContent = 'center';
        uploadedFile = null;
        chatHistory = [];
    });

    suggestionPrompts.forEach(button => {
        button.addEventListener('click', () => {
            chatInput.value = button.textContent;
            handleSendMessage();
        });
    });

    // --- MODIFIED: File Upload Listeners ---
    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => handleFileSelect(e.target.files[0]));

    // Re-target drag and drop to the entire input area
    chatInputArea.addEventListener('dragover', (e) => {
        e.preventDefault();
        chatInputArea.style.backgroundColor = 'var(--bg-input)';
    });
    chatInputArea.addEventListener('dragleave', () => {
        chatInputArea.style.backgroundColor = 'transparent';
    });
    chatInputArea.addEventListener('drop', (e) => {
        e.preventDefault();
        chatInputArea.style.backgroundColor = 'transparent';
        const file = e.dataTransfer.files[0];
        if (file) {
            handleFileSelect(file);
        }
    });

    // Logout Listener
    if (logoutBtn) logoutBtn.addEventListener('click', () => { window.location.href = '/logout'; });

    // Mobile Navigation Logic
    function toggleSidebar() {
        sidebar.classList.toggle('sidebar-open');
        mobileOverlay.classList.toggle('active');
    }

    mobileMenuBtn.addEventListener('click', toggleSidebar);
    mobileOverlay.addEventListener('click', toggleSidebar);
});