/**
* Module that controls the WEKO user settings. Includes Knockout view-model
* for syncing data.
*/

var ko = require('knockout');
var $ = require('jquery');
var Raven = require('raven-js');
var bootbox = require('bootbox');
require('js/osfToggleHeight');

var language = require('js/osfLanguage').Addons.weko;
var osfHelpers = require('js/osfHelpers');
var addonSettings = require('js/addonSettings');
var ChangeMessageMixin = require('js/changeMessage');

var ExternalAccount = addonSettings.ExternalAccount;

var $modal = $('#wekoInputCredentials');

var $osf = require('js/osfHelpers');

var _ = require('js/rdmGettext')._;
var sprintf = require('agh.sprintf').sprintf;

function ViewModel(configUrl, accountsUrl) {
    var self = this;

    self.properName = 'WEKO';
    self.selectedRepo = ko.observable();
    self.repositories = ko.observableArray();
    self.account_url = '/api/v1/settings/weko/accounts/';
    self.accounts = ko.observableArray();

    ChangeMessageMixin.call(self);

    /** Reset all fields from WEKO credentials input modal */
    self.clearModal = function() {
        self.message('');
        self.messageClass('text-info');
        self.selectedRepo(null);
    };

    self.setMessage = function(msg, cls) {
        var self = this;
        self.message(msg);
        self.messageClass(cls || 'text-info');
    };

    /** Send POST request to authorize WEKO */
    self.connectOAuth = function() {
        var self = this;
        // Selection should not be empty
        if(!self.selectedRepo()) {
            self.changeMessage('Please select WEKO repository.', 'text-danger');
            return;
        }
        window.oauthComplete = function() {
            self.setMessage('');
            var accountCount = self.accounts().length;
            self.updateAccounts().done( function() {
                if (self.accounts().length > accountCount) {
                    self.setMessage(sprintf(_('Add-on successfully authorized. To link this add-on to an GakuNin RDM project, go to the settings page of the project, enable %1$s, and choose content to connect.'),self.properName), 'text-success');
                } else {
                    self.setMessage(sprintf(_('Error while authorizing add-on. Please log in to your %1$s account and grant access to the GakuNin RDM to enable this add-on.'),self.properName), 'text-danger');
                }
            });
        };
        window.open('/oauth/connect/weko/' + self.selectedRepo().id + '/');
        $modal.modal('hide');
    };

    self.updateAccounts = function() {
        return $.ajax({
            url: accountsUrl,
            type: 'GET',
            dataType: 'json'
        }).done(function (data) {
            self.accounts($.map(data.accounts, function(account) {
                var externalAccount =  new ExternalAccount(account);
                externalAccount.accessKey = account.oauth_key;
                externalAccount.secretKey = account.oauth_secret;
                return externalAccount;
            }));
            $('#weko-header').osfToggleHeight({height: 160});
        }).fail(function(xhr, status, error) {
            self.changeMessage(language.userSettingsError, 'text-danger');
            Raven.captureMessage('Error while updating addon account', {
                extra: {
                    url: accountsUrl,
                    status: status,
                    error: error
                }
            });
        });
    };

    self.askDisconnect = function(account) {
        var self = this;
        bootbox.confirm({
            title: _('Disconnect Account?'),
            message: '<p class="overflow">' +
                sprintf(_('Are you sure you want to disconnect the %1$s account <strong>%2$s</strong>? This will revoke access to %1$s for all projects you have authorized.'),
                $osf.htmlEscape(self.properName),$osf.htmlEscape(account.name)) +
                '</p>',
            callback: function (confirm) {
                if (confirm) {
                    self.disconnectAccount(account);
                }
            },
            buttons:{
                confirm:{
                    label:_('Disconnect'),
                    className:'btn-danger'
                }
            }
        });
    };

    self.disconnectAccount = function(account) {
        var self = this;
        var url = '/api/v1/oauth/accounts/' + account.id + '/';
        var request = $.ajax({
            url: url,
            type: 'DELETE'
        });
        request.done(function(data) {
            self.updateAccounts();
        });
        request.fail(function(xhr, status, error) {
            Raven.captureMessage('Error while removing addon authorization for ' + account.id, {
                extra: {
                    url: url,
                    status: status,
                    error: error
                }
            });
        });
        return request;
    };

    self.selectionChanged = function() {
        self.changeMessage('','');
    };

    self.fetch = function() {
        $.ajax({
            url: configUrl,
            type: 'GET',
            dataType: 'json'
        }).done(function (response) {
            var data = response.result;
            self.repositories(data.repositories);
            self.updateAccounts();
        }).fail(function (xhr, textStatus, error) {
            self.changeMessage(language.userSettingsError, 'text-danger');
            Raven.captureMessage('Could not GET WEKO settings', {
                extra: {
                    url: configUrl,
                    textStatus: textStatus,
                    error: error
                }
            });
        });
    };

    self.updateAccounts();
}

$.extend(ViewModel.prototype, ChangeMessageMixin.prototype);

function WEKOUserConfig(selector, configUrl, accountsUrl) {
    // Initialization code
    var self = this;
    self.selector = selector;
    self.configUrl = configUrl;
    self.accountsUrl = accountsUrl;
    // On success, instantiate and bind the ViewModel
    self.viewModel = new ViewModel(configUrl, accountsUrl);
    osfHelpers.applyBindings(self.viewModel, self.selector);
}

module.exports = {
    WEKOViewModel: ViewModel,
    WEKOUserConfig: WEKOUserConfig
};
