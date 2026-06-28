var _ = require('underscore');

var Ipfs = function () {
	var self = this;

	var apiUrl = process.env.IPFS_API_URL || 'http://127.0.0.1:5001';
	var gatewayUrl = process.env.IPFS_GATEWAY_URL || 'https://ipfs.io/ipfs/';

	self.apiUrl = apiUrl;
	self.gatewayUrl = gatewayUrl;

	self.addFile = function (buffer, filename) {
		if (!filename) filename = 'file';

		var boundary = '----' + Date.now().toString(36) + Math.random().toString(36).slice(2);

		var header = '--' + boundary + '\r\n'
			+ 'Content-Disposition: form-data; name="file"; filename="' + filename + '"\r\n'
			+ 'Content-Type: application/octet-stream\r\n\r\n';

		var footer = '\r\n--' + boundary + '--\r\n';

		var body = Buffer.concat([
			Buffer.from(header, 'utf-8'),
			buffer,
			Buffer.from(footer, 'utf-8'),
		]);

		return fetch(apiUrl + '/api/v0/add?pin=true&progress=false', {
			method: 'POST',
			headers: {
				'Content-Type': 'multipart/form-data; boundary=' + boundary,
			},
			body: body,
		})
			.then(function (r) {
				if (!r.ok) {
					return r.text().then(function (t) {
						return Promise.reject({ error: 'ipfs_add_failed', detail: t, code: 502 });
					});
				}
				return r.json();
			})
			.then(function (result) {
				return {
					cid: result.Hash,
					size: result.Size,
				};
			});
	};

	self.pin = function (cid) {
		return fetch(apiUrl + '/api/v0/pin/add?arg=' + cid, {
			method: 'POST',
		})
			.then(function (r) {
				if (!r.ok) return Promise.reject({ error: 'ipfs_pin_failed', code: 502 });
				return r.json();
			})
			.then(function () {
				return { cid: cid, pinned: true };
			});
	};

	self.remove = function (cid) {
		return fetch(apiUrl + '/api/v0/pin/rm?arg=' + cid, { method: 'POST' })
			.then(function (r) {
				if (!r.ok) return Promise.reject({ error: 'ipfs_unpin_failed', code: 502 });
				return r.json();
			})
			.then(function () {
				return { cid: cid, removed: true };
			});
	};

	self.info = function () {
		return {
			apiUrl: apiUrl,
			gatewayUrl: gatewayUrl,
		};
	};

	self.api = {
		upload: {
			path: '/ipfs/upload',
			source: true,
			action: function (data, request) {
				var buffer = data._raw;
				var filename = data.filename || 'video.mp4';

				if (!buffer || !buffer.length) {
					return Promise.reject({ error: 'no_data', code: 400 });
				}

				return self.addFile(buffer, filename).then(function (result) {
					return Promise.resolve({
						data: {
							cid: result.cid,
							size: result.size,
							gateway: gatewayUrl + result.cid,
						},
						code: 200,
					});
				});
			},
		},
	};

	return self;
};

module.exports = Ipfs;
