/*
Copyright 2013 The Perkeep Authors

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

	http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

goog.provide('cam.SearchSession');

goog.require('goog.events.EventTarget');
goog.require('goog.Uri');
goog.require('goog.Uri.QueryData');
goog.require('goog.uri.utils');

goog.require('cam.ServerConnection');

// A search session is a standing query that notifies you when results change. It caches previous results and handles merging new data as it is received. It does not tell you _what_ changed; clients must reconcile as they see fit.
//
// TODO(aa): Only deltas should be sent from server to client
// TODO(aa): Need some way to avoid the duplicate query when websocket starts. Ideas:
// - Initial XHR query can also specify tag. This tag times out if not used rapidly. Send this same tag in socket query.
// - Socket assumes that client already has first batch of results (slightly racey though)
// - Prefer to use socket on client-side, test whether it works and fall back to XHR if not.
cam.SearchSession = function(connection, currentUri, query, opt_getDialog, opt_aroundBlobref, opt_sort) {
	goog.base(this);

	this.connection_ = connection;
	this.currentUri_ = currentUri;
	this.getDialog_ = opt_getDialog || function(message) { console.log(message) };
	this.initSocketUri_(currentUri);
	this.hasSocketError_ = false;
	this.query_ = query;
	this.around_ = opt_aroundBlobref;
	this.sort_ = opt_sort || "-created";
	this.tag_ = 'q' + (this.constructor.instanceCount_++);
	this.continuation_ = this.getContinuation_(this.constructor.SEARCH_SESSION_CHANGE_TYPE.NEW);
	this.socket_ = null;
	this.supportsWebSocket_ = false;
	this.isComplete_ = false;

	this.resetData_();
};
goog.inherits(cam.SearchSession, goog.events.EventTarget);

// We fire this event when the data changes in any way.
cam.SearchSession.SEARCH_SESSION_CHANGED = 'search-session-change';

// We fire this event when the search session receives general server status data.
cam.SearchSession.SEARCH_SESSION_STATUS = 'search-session-status';

// We fire this event when the search session encounters an error.
cam.SearchSession.SEARCH_SESSION_ERROR = 'search-session-error';

// TODO(aa): This is only used by BlobItemContainer. Once we switch over to BlobItemContainerReact completely, it can be removed.
cam.SearchSession.SEARCH_SESSION_CHANGE_TYPE = {
	NEW: 1,
	APPEND: 2,
	UPDATE: 3
};

cam.SearchSession.PAGE_SIZE_ = 50;

cam.SearchSession.instanceCount_ = 0;

cam.SearchSession.prototype.getQuery = function() {
	return this.query_;
};

// getQueryExprOrRef returns the query if is a string (i.e. a search
// expression). Otherwise it returns the empty string.
cam.SearchSession.prototype.getQueryExprOrRef = function() {
	var q = this.query_;
	if (!q) {
		return '';
	}
	if (typeof q === 'string') {
		return q.trim();
	}
	// if it is an object (ugh!) return the blobRefPrefix if it exists
	if (!q.blobRefPrefix) {
		return '';
	}
	return 'ref:'+q.blobRefPrefix;
};

// stripMapZoom allows us to "hide" the map aspect zoom from when the search
// session sends a query to the server. We want to keep this.query_ intact (with
// the map zoom) though, because the map aspect relies on this.query_ as a
// bootstrap. This is a terrible hack that should eventually go.
cam.SearchSession.prototype.stripMapZoom = function(q) {
	if (!q) {
		return null;
	}
	if (typeof q === 'string') {
		return goreact.DeleteMapZoom(q);
	}
	return q;
};

cam.SearchSession.prototype.isEmptyQuery = function() {
	var q = this.query_;
	if (!q) {
		return true;
	}
	if (typeof q === 'string') {
		if (q.trim() == "") {
			return true;
		}
	}
	return false;
};

cam.SearchSession.prototype.getAround = function() {
	return this.around_;
};

cam.SearchSession.prototype.getSort = function() {
	return this.sort_;
};

// Returns all the data we currently have loaded.
// It is guaranteed to return the following properties:
// blobs // non-null
// description
// description.meta
cam.SearchSession.prototype.getCurrentResults = function() {
	return this.data_;
};

cam.SearchSession.prototype.hasSocketError = function() {
	return this.hasSocketError_;
};

// Loads the next page of data. This is safe to call while a load is in progress; multiple calls for the same page will be collapsed. The SEARCH_SESSION_CHANGED event will be dispatched when the new data is available.
cam.SearchSession.prototype.loadMoreResults = function() {
	if (!this.continuation_) {
		return;
	}

	var c = this.continuation_;
	this.continuation_ = null;
	c();
};

// Returns true if it is known that all data which can be loaded for this query has been.
cam.SearchSession.prototype.isComplete = function() {
	return this.isComplete_;
}

cam.SearchSession.prototype.supportsChangeNotifications = function() {
	return this.supportsWebSocket_;
};

cam.SearchSession.prototype.refreshIfNecessary = function() {
	if (this.supportsWebSocket_) {
		return;
	}

	this.continuation_ = this.getContinuation_(this.constructor.SEARCH_SESSION_CHANGE_TYPE.UPDATE, {
		limit: Math.max(this.data_.blobs.length, this.constructor.PAGE_SIZE_),
	});
	this.resetData_();
	this.loadMoreResults();
};

cam.SearchSession.prototype.close = function() {
	if (this.socket_) {
		this.socket_.onerror = null;
		this.socket_.onclose = null;
		this.socket_.close();
	}
};

cam.SearchSession.prototype.getMeta = function(blobref) {
	return this.data_.description.meta[blobref];
};

cam.SearchSession.prototype.getResolvedMeta = function(blobref) {
	var meta = this.data_.description.meta[blobref];
	if (meta && meta.camliType == 'permanode') {
		var camliContent = cam.permanodeUtils.getSingleAttr(meta.permanode, 'camliContent');
		if (camliContent) {
			return this.data_.description.meta[camliContent];
		}
	}
	return meta;
};

cam.SearchSession.prototype.getTitle = function(blobref) {
	var meta = this.getMeta(blobref);
	if (meta.camliType == 'permanode') {
		var title = cam.permanodeUtils.getSingleAttr(meta.permanode, 'title');
		if (title) {
			return title;
		}
	}
	var rm = this.getResolvedMeta(blobref);
	return (rm && rm.camliType == 'file' && rm.file.fileName) || (rm && rm.camliType == 'directory' && rm.dir.fileName) || '';
};

cam.SearchSession.prototype.resetData_ = function() {
	this.data_ = {
		blobs: [],
		description: {
			meta: {}
		}
	};
};

cam.SearchSession.prototype.initSocketUri_ = function(currentUri) {
	if (!goog.global.WebSocket) {
		return;
	}

	this.socketUri_ = currentUri;
	this.socketUri_.setFragment('');
	var config = this.connection_.getConfig();
	this.socketUri_.setPath(goog.uri.utils.appendPath(config.searchRoot, 'camli/search/ws'));
	this.socketUri_.setQuery(goog.Uri.QueryData.createFromMap({authtoken: config.authToken || ''}));
	if (this.socketUri_.getScheme() == "https") {
		this.socketUri_.setScheme("wss");
	} else {
		this.socketUri_.setScheme("ws");
	}
};

cam.SearchSession.prototype.getContinuation_ = function(changeType, opts) {
	if (!opts) {
		opts = {};
	}
	if (!opts.limit) {
		opts.limit = this.constructor.PAGE_SIZE_;
	}
	if (!opts.sort) {
		opts.sort = this.sort_;
	}
	opts.describe = cam.ServerConnection.DESCRIBE_REQUEST;

	return this.connection_.search.bind(this.connection_, this.stripMapZoom(this.query_), opts,
		function(result) {
			if (result && result.error && result.error != '') {
				this.getDialog_(result.error);
				return;
			}
			this.searchDone_(changeType, result);
		}.bind(this));
};

cam.SearchSession.prototype.searchDone_ = function(changeType, result) {
	if (!result) {
		result = {};
	}
	if (!result.blobs) {
		result.blobs = [];
	}
	if (!result.description) {
		result.description = {};
	}

	var changes = false;

	if (changeType == this.constructor.SEARCH_SESSION_CHANGE_TYPE.APPEND) {
		changes = Boolean(result.blobs.length);
		this.data_.blobs = this.data_.blobs.concat(result.blobs);
		goog.mixin(this.data_.description.meta, result.description.meta);
	} else {
		changes = true;
		this.data_.blobs = result.blobs;
		this.data_.description = result.description;
	}

	if (result.continue) {
		this.continuation_ = this.getContinuation_(this.constructor.SEARCH_SESSION_CHANGE_TYPE.APPEND, {
			continuationToken: result.continue,
		});
	} else {
		this.continuation_ = null;
		this.isComplete_ = true;
	}

	if (changes) {
		this.dispatchEvent({type: this.constructor.SEARCH_SESSION_CHANGED, changeType: changeType});

		if (changeType == this.constructor.SEARCH_SESSION_CHANGE_TYPE.NEW || changeType == this.constructor.SEARCH_SESSION_CHANGE_TYPE.APPEND) {
			this.startSocketQuery_();
		}
	}
};

cam.SearchSession.prototype.handleError_ = function(message) {
	this.hasSocketError_ = true;
	this.dispatchEvent({type: this.constructor.SEARCH_SESSION_ERROR});
};

cam.SearchSession.prototype.handleStatus_ = function(data) {
	if (data.tag == '_status') {
		this.dispatchEvent({
			type: this.constructor.SEARCH_SESSION_STATUS,
			status: data.status,
		});
	}
};

cam.SearchSession.prototype.startSocketQuery_ = function() {
	if (!this.socketUri_) {
		return;
	}

	this.close();

	var numResults = 0;
	if (this.data_ && this.data_.blobs) {
		numResults = this.data_.blobs.length;
	}
	var queryOpts = {
		describe: cam.ServerConnection.DESCRIBE_REQUEST,
		limit: Math.max(numResults, this.constructor.PAGE_SIZE_),
		around: this.around_,
		sort: this.sort_,
	};
	var query = this.connection_.buildQuery(this.stripMapZoom(this.query_), queryOpts);

	this.socket_ = new WebSocket(this.socketUri_.toString());
	this.socket_.onopen = function() {
		var message = {
			tag: this.tag_,
			query: query
		};
		this.socket_.send(JSON.stringify(message));
	}.bind(this);
	this.socket_.onclose =
	this.socket_.onerror = function(e) {
		this.handleError_('WebSocket error - click to reload');
	}.bind(this);
	this.socket_.onmessage = function(e) {
		this.supportsWebSocket_ = true;
		this.handleStatus_(JSON.parse(e.data));
		// Ignore the first response.
		this.socket_.onmessage = function(e) {
			var result = JSON.parse(e.data);
			this.handleStatus_(result);
			if (result.tag == this.tag_) {
				this.searchDone_(this.constructor.SEARCH_SESSION_CHANGE_TYPE.UPDATE, result.result);
			}
		}.bind(this);
	}.bind(this);
};
