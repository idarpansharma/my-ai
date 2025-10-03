# netlify_handler.py

from serverless_wsgi import handle
from app import app  # This imports your Flask app instance from your app.py file

def handler(event, context):
    """
    This is the entry point for the Netlify Function.
    It takes the incoming request (event) and passes it to your Flask app.
    """
    return handle(app, event, context)