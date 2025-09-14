#!/usr/bin/env python3
import http.server
import ssl
import socketserver
import os

PORT = 8000

class MyHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory='ar', **kwargs)
    
    def end_headers(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        super().end_headers()
    
    def do_GET(self):
        # Handle dpdb.json request locally to avoid CORS issues
        if self.path == '/dpdb.json':
            try:
                # Try to serve the local dpdb.json file
                with open('ar/dpdb.json', 'r') as f:
                    dpdb_data = f.read()
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(dpdb_data.encode())
            except FileNotFoundError:
                # Fallback to minimal dpdb.json if file not found
                self.send_response(200)
                self.send_header('Content-type', 'application/json')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                dpdb_data = '{"devices": []}'
                self.wfile.write(dpdb_data.encode())
        else:
            super().do_GET()

# Create the server
with socketserver.TCPServer(("0.0.0.0", PORT), MyHTTPRequestHandler) as httpd:
    # Wrap the socket with SSL
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain('/Users/jonas/Documents/GitHub/localhost.pem', '/Users/jonas/Documents/GitHub/localhost-key.pem')
    httpd.socket = context.wrap_socket(httpd.socket, server_side=True)
    
    print(f"Serving HTTPS on port {PORT}")
    print(f"Access your AR app at: https://192.168.1.31:{PORT}")
    print("Note: You may need to accept the self-signed certificate in your browser")
    
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
