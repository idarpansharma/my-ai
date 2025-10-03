# functions/netlify_handler.py
import json

def handler(event, context):
    """
    A simple "Hello World" function to test deployment.
    """
    print("Hello world function was called!")
    return {
        "statusCode": 200,
        "body": json.dumps({ "message": "Success! Your function is working!" })
    }