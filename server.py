# 本機遊戲伺服器：跟 python -m http.server 一樣，但要求瀏覽器每次都檢查檔案有沒有更新，
# 避免改了程式之後瀏覽器還在跑舊版的 JS。
#
#   python server.py 8765            電腦自己玩（http://localhost，攝影機可用）
#   python server.py 8443 --https    給同一個 Wi-Fi 的手機玩（手機只有 https 才能開攝影機，
#                                    會自動產生自簽憑證，並顯示網址與 QR code）
import datetime
import http.server
import ipaddress
import os
import socket
import ssl
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
CERT_DIR = os.path.join(ROOT, 'cert')


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript',
        '.mjs': 'text/javascript',
        '.css': 'text/css',
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()


def lan_ips():
    ips = set()
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_DGRAM) as s:
            s.connect(('8.8.8.8', 80))
            ips.add(s.getsockname()[0])
    except OSError:
        pass
    for info in socket.getaddrinfo(socket.gethostname(), None, socket.AF_INET):
        ips.add(info[4][0])
    return [ip for ip in ips if not ip.startswith(('127.', '169.254.'))]


def primary_ip(ips):
    for ip in ips:
        if ip.startswith('192.168.'):
            return ip
    return ips[0] if ips else '127.0.0.1'


def ensure_cert(ips):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.x509.oid import NameOID

    cert_path = os.path.join(CERT_DIR, 'cert.pem')
    key_path = os.path.join(CERT_DIR, 'key.pem')
    wanted = {ipaddress.ip_address(ip) for ip in ips + ['127.0.0.1']}
    if os.path.exists(cert_path) and os.path.exists(key_path):
        with open(cert_path, 'rb') as f:
            cert = x509.load_pem_x509_certificate(f.read())
        san = cert.extensions.get_extension_for_class(x509.SubjectAlternativeName).value
        if wanted <= set(san.get_values_for_type(x509.IPAddress)):
            return cert_path, key_path

    os.makedirs(CERT_DIR, exist_ok=True)
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Yakyuken Local')])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=825))
        .add_extension(
            x509.SubjectAlternativeName([x509.DNSName('localhost')] + [x509.IPAddress(ip) for ip in wanted]),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    with open(key_path, 'wb') as f:
        f.write(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL,
                                  serialization.NoEncryption()))
    with open(cert_path, 'wb') as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))
    return cert_path, key_path


def show_qr(url):
    try:
        import qrcode
    except ImportError:
        return
    qr = qrcode.QRCode(border=2)
    qr.add_data(url)
    qr.make()
    path = os.path.join(CERT_DIR, 'phone_qr.png')
    qr.make_image(fill_color='black', back_color='white').resize((480, 480)).save(path)
    try:
        qr.print_ascii(invert=True)
    except UnicodeEncodeError:
        pass
    if hasattr(os, 'startfile'):
        os.startfile(path)


def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    https = '--https' in sys.argv
    port = int(args[0]) if args else (8443 if https else 8765)

    if not https:
        httpd = http.server.ThreadingHTTPServer(('127.0.0.1', port), Handler)
        print(f'野球拳伺服器： http://localhost:{port}/')
    else:
        ips = lan_ips()
        cert_path, key_path = ensure_cert(ips)
        httpd = http.server.ThreadingHTTPServer(('0.0.0.0', port), Handler)
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(cert_path, key_path)
        httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
        url = f'https://{primary_ip(ips)}:{port}/'
        print('=' * 60)
        print(' 手機版野球拳（手機要跟這台電腦連同一個 Wi-Fi）')
        print(f' 用手機開： {url}')
        for ip in ips:
            if ip != primary_ip(ips):
                print(f'   （連不上可以試試 https://{ip}:{port}/）')
        print(' 第一次會出現「連線不是私人連線 / 憑證不安全」的警告：')
        print('   Android Chrome：進階 → 繼續前往')
        print('   iPhone Safari：顯示詳細資訊 → 造訪此網站')
        print(' Windows 防火牆若跳出詢問，請按「允許存取」。')
        print('=' * 60)
        show_qr(url)
    httpd.serve_forever()


if __name__ == '__main__':
    main()
