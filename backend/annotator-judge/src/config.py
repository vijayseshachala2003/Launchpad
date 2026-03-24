# src/config.py
import os
from dotenv import load_dotenv

def configure_api():
    """
    Loads API keys from environment variables or .env file.
    Supports multiple LLM providers.
    """
    load_dotenv()
    
    # Google Gemini
    google_key = os.getenv("GOOGLE_API_KEY")
    if google_key:
        try:
            import google.generativeai as genai
            genai.configure(api_key=google_key)
            print("Google Gemini API configured successfully.")
        except ImportError:
            print("Warning: google-generativeai not installed. Gemini models unavailable.")
    
    # Together AI
    together_key = os.getenv("TOGETHER_API_KEY") or os.getenv("TOGETHER_API")
    if together_key:
        os.environ["TOGETHER_API_KEY"] = together_key
        print("Together API key configured successfully.")
    
    if not google_key and not together_key:
        print("Warning: No API keys found. Set GOOGLE_API_KEY or TOGETHER_API_KEY in .env file.")
