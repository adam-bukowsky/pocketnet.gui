const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const DAEMON_READY_TIMEOUT = 30000;
const DAEMON_STOP_TIMEOUT = 10000;
const KUBO_API_PORT = 5001;
const KUBO_GATEWAY_PORT = 8080;

var Daemon = function (ipcMain, storagePath) {
	var self = this;

	var process = null;
	var started = false;
	var apiUrl = 'http://127.0.0.1:' + KUBO_API_PORT;
	var gatewayUrl = 'http://127.0.0.1:' + KUBO_GATEWAY_PORT;
	var ipfsPath = null;
	var readyResolve = null;
	var readyReject = null;
	var readyPromise = null;

	var binPath = null;

	var kuboPlatform = function () {
		var p = process.platform;
		var a = process.arch;

		if (p === 'win32') return 'windows/kubo.exe';
		if (p === 'darwin' && a === 'arm64') return 'macos-arm64/kubo';
		if (p === 'darwin') return 'macos-x64/kubo';
		return 'linux/kubo';
	};

	var findBinary = function () {
		var relPath = kuboPlatform();

		var candidates = [
			path.join(__dirname, '..', '..', 'ipfs', relPath),
			path.join(process.resourcesPath || '', 'ipfs', relPath),
			path.join(storagePath || '', 'ipfs', relPath),
		];

		for (var i = 0; i < candidates.length; i++) {
			var p = candidates[i];
			if (fs.existsSync(p)) return p;
		}

		return null;
	};

	var initRepo = function () {
		ipfsPath = path.join(storagePath || os.tmpdir(), '.ipfs');

		if (fs.existsSync(path.join(ipfsPath, 'config'))) return Promise.resolve();

		return new Promise(function (resolve, reject) {
			var init = spawn(binPath, ['init', '--profile=server'], {
				env: { ...process.env, IPFS_PATH: ipfsPath },
				stdio: ['ignore', 'pipe', 'pipe'],
			});

			var stderr = '';
			init.stderr.on('data', function (d) { stderr += d.toString(); });

			init.on('close', function (code) {
				if (code === 0) resolve();
				else reject('ipfs_init_failed: ' + stderr);
			});

			init.on('error', function (e) { reject('ipfs_init_error: ' + e.message); });
		});
	};

	var waitForApi = function (timeout) {
		var start = Date.now();

		return new Promise(function (resolve, reject) {
			var check = function () {
				if (Date.now() - start > timeout) {
					reject('ipfs_api_timeout');
					return;
				}

				var req = http.get(apiUrl + '/api/v0/version', function (res) {
					if (res.statusCode === 200) resolve();
					else setTimeout(check, 500);
				});

				req.on('error', function () { setTimeout(check, 500); });
				req.setTimeout(2000, function () { req.destroy(); setTimeout(check, 500); });
			};

			check();
		});
	};

	var handleIpc = function () {
		ipcMain.on('Ipfs:AddFile', function (event, filePath) {
			apiRequest('/api/v0/add?pin=true', filePath, event.sender, 'Ipfs:AddFile:Result', 'Ipfs:AddFile:Error');
		});

		ipcMain.on('Ipfs:Pin', function (event, cid) {
			apiRequest('/api/v0/pin/add?arg=' + cid, null, event.sender, 'Ipfs:Pin:Result', 'Ipfs:Pin:Error');
		});

		ipcMain.on('Ipfs:Unpin', function (event, cid) {
			apiRequest('/api/v0/pin/rm?arg=' + cid, null, event.sender, 'Ipfs:Unpin:Result', 'Ipfs:Unpin:Error');
		});

		ipcMain.on('Ipfs:Stats', function (event) {
			Promise.all([
				apiFetch('/api/v0/repo/stat'),
				apiFetch('/api/v0/swarm/peers'),
				apiFetch('/api/v0/id'),
			]).then(function (results) {
				event.sender.send('Ipfs:Stats:Result', {
					repoSize: results[0].RepoSize,
					numPins: results[0].NumObjects,
					peers: results[1].Peers ? results[1].Peers.length : 0,
					id: results[2].ID,
					apiUrl: apiUrl,
					gatewayUrl: gatewayUrl,
				});
			}).catch(function (e) {
				event.sender.send('Ipfs:Stats:Error', e.message || e);
			});
		});

		ipcMain.on('Ipfs:IsReady', function (event) {
			event.sender.send('Ipfs:IsReady:Result', started);
		});

		ipcMain.on('Ipfs:GatewayUrl', function (event, cid) {
			event.sender.send('Ipfs:GatewayUrl:Result', gatewayUrl + '/' + cid);
		});
	};

	var apiFetch = function (apiPath) {
		return new Promise(function (resolve, reject) {
			var req = http.get(apiUrl + apiPath, function (res) {
				var data = '';
				res.on('data', function (d) { data += d.toString(); });
				res.on('end', function () {
					try { resolve(JSON.parse(data)); }
					catch (e) { reject('ipfs_parse_error'); }
				});
			});
			req.on('error', function (e) { reject(e.message); });
			req.setTimeout(10000, function () { req.destroy(); reject('ipfs_timeout'); });
		});
	};

	var apiRequest = function (apiPath, filePath, sender, resultEvent, errorEvent) {
		var options = new URL(apiUrl + apiPath);

		var httpOptions = {
			hostname: options.hostname,
			port: options.port,
			path: options.pathname + options.search,
			method: 'POST',
		};

		var req = http.request(httpOptions, function (res) {
			var data = '';
			res.on('data', function (d) { data += d.toString(); });
			res.on('end', function () {
				try {
					var result = JSON.parse(data);
					if (result.Hash) {
						sender.send(resultEvent, { cid: result.Hash, size: result.Size });
					} else {
						sender.send(resultEvent, result);
					}
				} catch (e) {
					sender.send(errorEvent, 'ipfs_parse_error');
				}
			});
		});

		req.on('error', function (e) {
			sender.send(errorEvent, e.message);
		});

		if (filePath) {
			var stat = fs.statSync(filePath);
			var boundary = '----' + Date.now().toString(36);
			var header = '--' + boundary + '\r\n'
				+ 'Content-Disposition: form-data; name="file"; filename="' + path.basename(filePath) + '"\r\n'
				+ 'Content-Type: application/octet-stream\r\n\r\n';
			var footer = '\r\n--' + boundary + '--\r\n';

			req.setHeader('Content-Type', 'multipart/form-data; boundary=' + boundary);
			req.setHeader('Content-Length', Buffer.byteLength(header) + stat.size + Buffer.byteLength(footer));
			req.write(header);
			fs.createReadStream(filePath).pipe(req, { end: false });
			req.on('pipe', function () {
				req.end(footer);
			});
		} else {
			req.setHeader('Content-Type', 'application/json');
			req.end();
		}
	};

	self.start = function () {
		if (started) return Promise.resolve();

		binPath = findBinary();
		if (!binPath) return Promise.reject('ipfs_binary_not_found');

		ipfsPath = path.join(storagePath || os.tmpdir(), '.ipfs');

		return initRepo().then(function () {
			return new Promise(function (resolve, reject) {
				readyResolve = resolve;
				readyReject = reject;
				readyPromise = { resolve: resolve, reject: reject };

				process = spawn(binPath, ['daemon', '--migrate=true'], {
					env: { ...process.env, IPFS_PATH: ipfsPath },
					stdio: ['ignore', 'pipe', 'pipe'],
				});

				process.stderr.on('data', function (d) {
					var line = d.toString();
					if (line.indexOf('Daemon is ready') !== -1) {
						started = true;
						if (readyResolve) readyResolve();
					}
				});

				process.on('exit', function (code) {
					started = false;
					process = null;
					if (readyReject) readyReject('ipfs_daemon_exit:' + code);
				});

				process.on('error', function (e) {
					started = false;
					process = null;
					if (readyReject) readyReject('ipfs_daemon_error:' + e.message);
				});

				handleIpc();

				waitForApi(DAEMON_READY_TIMEOUT).then(function () {
					started = true;
					if (readyResolve) readyResolve();
				}).catch(function (e) {
					if (readyReject) readyReject(e);
				});
			});
		});
	};

	self.stop = function () {
		if (!process) return Promise.resolve();

		return new Promise(function (resolve) {
			var killed = false;

			var timer = setTimeout(function () {
				if (!killed) {
					killed = true;
					process.kill('SIGKILL');
					resolve();
				}
			}, DAEMON_STOP_TIMEOUT);

			process.on('exit', function () {
				if (!killed) {
					killed = true;
					clearTimeout(timer);
					started = false;
					process = null;
					resolve();
				}
			});

			process.kill('SIGTERM');
		});
	};

	self.isReady = function () {
		return started;
	};

	self.info = function () {
		return {
			running: started,
			apiUrl: apiUrl,
			gatewayUrl: gatewayUrl,
			ipfsPath: ipfsPath,
			binary: binPath,
		};
	};
};

var Client = function (ipcRender) {
	var self = this;

	self.addFile = function (filePath) {
		return new Promise(function (resolve, reject) {
			ipcRender.once('Ipfs:AddFile:Result', function (e, result) { resolve(result); });
			ipcRender.once('Ipfs:AddFile:Error', function (e, err) { reject(err); });
			ipcRender.send('Ipfs:AddFile', filePath);
		});
	};

	self.pin = function (cid) {
		return new Promise(function (resolve, reject) {
			ipcRender.once('Ipfs:Pin:Result', function (e, result) { resolve(result); });
			ipcRender.once('Ipfs:Pin:Error', function (e, err) { reject(err); });
			ipcRender.send('Ipfs:Pin', cid);
		});
	};

	self.unpin = function (cid) {
		return new Promise(function (resolve, reject) {
			ipcRender.once('Ipfs:Unpin:Result', function (e, result) { resolve(result); });
			ipcRender.once('Ipfs:Unpin:Error', function (e, err) { reject(err); });
			ipcRender.send('Ipfs:Unpin', cid);
		});
	};

	self.stats = function () {
		return new Promise(function (resolve, reject) {
			ipcRender.once('Ipfs:Stats:Result', function (e, result) { resolve(result); });
			ipcRender.once('Ipfs:Stats:Error', function (e, err) { reject(err); });
			ipcRender.send('Ipfs:Stats');
		});
	};

	self.isReady = function () {
		return new Promise(function (resolve) {
			ipcRender.once('Ipfs:IsReady:Result', function (e, result) { resolve(result); });
			ipcRender.send('Ipfs:IsReady');
		});
	};

	self.gatewayUrl = function (cid) {
		return new Promise(function (resolve) {
			ipcRender.once('Ipfs:GatewayUrl:Result', function (e, url) { resolve(url); });
			ipcRender.send('Ipfs:GatewayUrl', cid);
		});
	};
};

module.exports = { Daemon: Daemon, Client: Client };
