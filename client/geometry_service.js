'use strict';
// using https://github.com/infusion/BitSet.js
const bit=require("bitset");
const core=require("../protocol/core.js");
const nd=require("../scene/node.js");

var clientIDToIndex=new Map();
var nextIndex=0;

//! Each resource (node, texture, mesh etc) what MAY need to be streamed has a TrackedResource.
//! Then, within the TrackedResource class instance, we keep track of which clients:
//! * Need this resource
//! * Were sent the resource (and when)
//! * Acknowledged that the resource was received.
//! This is done with a bitset: each Client has an index. We set and clear the Client's bit in the
//! TrackedResource's bitset members to indicate the resource's status with respect to the client.
//!  The exception is sent_server_time_us: this is a Map from client ID to the time sent.
//! We remove these values when no longer needed, to prevent the maps from getting too large.
class TrackedResource
{
    constructor(){
        this.clientNeeds=new bit.BitSet();		    // whether we THINK the client NEEDS the resource.
        this.sent=new bit.BitSet();			        // Whether we have actually sent the resource,
        this.sent_server_time_us=new Map(); 		// and when we sent it. Map of clientID to timestamp.
        this.acknowledged=new bit.BitSet();	        // Whether the client acknowledged receiving the resource.
		
    }
	IsNeededByClient(clientID) {
		return this.clientNeeds.get[clientIDToIndex[clientID]];
	}
	WasSentToClient(clientID) {
		return this.sent.get[clientIDToIndex[clientID]];
	}
	WasAcknowledgedByClient(clientID) {
		return this.acknowledged.get(clientIDToIndex[clientID]);
	}
	GetTimeSent(clientID) {
		return this.sent_server_time_us[clientID];
	}
	Sent(clientID,timestamp) {
		this.sent.set(clientIDToIndex[clientID],true);
		this.acknowledged.set(clientIDToIndex[clientID],false);
		this.sent_server_time_us.set(clientID,timestamp);
	}
	AcknowledgeBy(clientID) {
		this.acknowledged.set(clientIDToIndex[clientID],true);
		// erase timestamp?
		this.sent_server_time_us.delete(clientID);
	}
	Timeout(clientID) {
		this.sent.set(clientIDToIndex[clientID],false);
		this.acknowledged.set(clientIDToIndex[clientID],false);
		this.sent_server_time_us.clear(clientID);
	}
};

//! One GeometryService per connected client.
class GeometryService
{
	//! One trackedResources shared acrosss all clients.
	static trackedResources=new Map();

    constructor(clientID) {
		this.clientID=clientID;
		clientIDToIndex.set(clientID,nextIndex++);
		this.originNodeId = 0;
		this.priority = 0;
		// The lowest priority for which the client has confirmed all the nodes we sent.
		// We only send lower-priority nodes when all higher priorities have been confirmed.
		this.lowest_confirmed_node_priority=-100000;
		// How many nodes we have unconfirmed 
		this.unconfirmed_priority_counts=new Map();
		// Nodes the client needs, we might not send all at once.
		this.nodesToStreamEventually=new Set();
		//!The nodes actually to stream.
		// When higher priority nodes are acknowledged,
		// lower priority nodes AND their resources are added.
		// This is a map from the resource uid's to the number of REASONS we have to stream it.
		//   e.g. if a texture is needed by two nodes, it should have 2 here.
		this.streamedNodes=new Map();//map<uid,int> 
		// Node resources are refcounted, they could be requested
		// by more than one node, and only when no node references
		//  them should they be removed.
		this.streamedMeshes=new Map();
		this.streamedMaterials=new Map();
		this.streamedTextures=new Map();
		this.streamedSkeletons=new Map();
		this.streamedBones=new Map();
		this.streamedAnimations=new Map();
		this.streamedTextCanvases=new Map();
		this.streamedFontAtlases=new Map();
    }
	SetScene(sc){
		this.scene=sc;
	}
	SetOriginNode(n_uid){
		if(this.originNodeId ==n_uid)
			return;
		this.originNodeId = n_uid;-
		this.StreamNode(n_uid);
	}
	StreamNode(uid) {
		// this client should stream node uid.
		if(!GeometryService.trackedResources.has(uid))
			GeometryService.trackedResources.set(uid,new TrackedResource());
		var res=GeometryService.trackedResources.get(uid);
		var index=clientIDToIndex.get(this.clientID);
		res.clientNeeds.set(index,true);
		// Add to the list of nodes this client should eventually receive:
		this.nodesToStreamEventually.add(uid);
	}
	UnstreamNode(uid) {
		if(!GeometryService.trackedResources.has(uid))
			return;
		var res=GeometryService.trackedResources.get(uid);
		var index=clientIDToIndex.get(this.clientID);
		res.clientNeeds.BitSet(index,false);
		// Should certainly be in this set:
		this.nodesToStreamEventually.delete(uid);
		// MAY not be in this set:
		this.streamedNodes.delete(uid);
	}
	AddOrRemoveNodeAndResources(node_uid, remove)
	{
		var diff=remove?-1:1;
		if(!this.streamedNodes.has(node_uid))
		{
			this.streamedNodes.set(node_uid,0);
		}
		else if(!remove)
		{
			return;
		}
		var node = this.scene.GetNode(node_uid);
		this.streamedNodes.set(node_uid,this.streamedNodes.get(node_uid)+diff);
		
		//std.vector<MeshNodeResources> meshResources;
		switch (node.data_type)
		{
			case nd.NodeDataType.None:
			case NodeDataType.Light:
				break;
			case NodeDataType.Skeleton:
			{
				//GetSkeletonNodeResources(node_uid, *node, meshResources);
			}
			break;
			case NodeDataType.Mesh:
				{
					var meshResources=GetMeshNodeResources(node_uid, node );
					if(node.renderState.globalIlluminationUid>0)
					{
						this.streamedTextures[node.renderState.globalIlluminationUid]+=diff;
					}
			
					if(node.skeletonNodeID!=0)
					{
						var skeletonnode = this.scene.getNode(node.skeletonNodeID);
						if(!skeletonnode)
						{
							//TELEPORT_CERR<<"Missing skeleton node "<<node.skeletonNodeID<<std.endl;
						}
						else
						{
							this.streamedNodes[node.skeletonNodeID]+=diff;
							meshResources=GetSkeletonNodeResources(node.skeletonNodeID, skeletonnode );
							for(var r of meshResources)
							{
								for(var b of r.boneIDs)
								{
									if(b)
										streamedNodes.set(b,streamedNodes.get(b)+diff);
								}
							}
						}
					}
				}
				break;
			case NodeDataType.TextCanvas:
				if(node.data_uid)
				{
					var textCanvas=this.scene.getTextCanvas(node.data_uid);
					if(c&&c.font_uid)
					{
						var fontAtlas =this.scene.getFontAtlas(c.font_uid);
						if(f)
						{
							if(node.data_uid)
								this.streamedTextCanvases[node.data_uid]+=diff;
							if(c.font_uid)
								this.streamedFontAtlases[c.font_uid]+=diff;
							if(f.font_texture_uid)
								this.streamedTextures[f.font_texture_uid]+=diff;
						}
					}
				}
				break;
			default:
				break;
		}
		if(meshResources)
		for(var m of meshResources)
		{
			for(var u of m.animationIDs)
			{
				this.streamedAnimations[u]+=diff;
			}
			for(var u of m.boneIDs)
			{
				this.streamedBones[u]+=diff;
			}
			for(var u of m.materials)
			{
				this.streamedMaterials[u.material_uid]+=diff;
				for(var t of u.texture_uids)
				{
					this.streamedTextures[t]+=diff;
				}
			}
			if(m.mesh_uid)
			{
				this.streamedMeshes[m.mesh_uid]+=diff;
			}
			if(m.skeletonAssetID)
			{
				this.streamedSkeletons[m.skeletonAssetID]+=diff;
			}
		}
	}
	GetNodesToStream() {
		// We have sets/maps of what the client SHOULD have, but some of these may have been sent already.
		let time_now_us=core.getTimestampUs();
		// ten seconds for timeout. Tweak this.
		const timeout_us=10000000;
		//  The set of ALL the nodes of sufficient priority that the client NEEDS is streamedNodes.
		for(let uid of this.nodesToStreamEventually)
		{
			if(!GeometryService.trackedResources.has(uid))
				continue;
			var res=GeometryService.trackedResources.get(uid);
			// The client eventually should need this node.
			// But if was already received we don't send it:
			if(res.WasAcknowledgedByClient(this.clientID))
				continue;
			if(res.WasSentToClient(this.clientID))
			{
				var timeSentUs=res.GetTimeSent(this.clientID);
				// If we sent it too long ago with no acknowledgement, we can send it again.
				if(time_now_us-timeSentUs>timeout_us)
				{
					res.Timeout(this.clientID);
				}
				else
				{
					continue;
				}
			}
			else
			{
				// if it hasn't been sent at all to our client, we add its resources.
				this.AddOrRemoveNodeAndResources(uid,false);
			}
			this.streamedNodes.set(uid,time_now_us);
			res.Sent(this.clientID,time_now_us);
		}
		return this.streamedNodes;
	}

	EncodedResource(resource_uid)
	{
		if(!GeometryService.trackedResources.has(resource_uid))
			return;
		var res=GeometryService.trackedResources.get(resource_uid);
		if(res) {
			let time_now_us=core.getTimestampUs();
			res.Sent(this.clientID,time_now_us);
		}
	}
	ConfirmResource(resource_uid)
	{
		if(!GeometryService.trackedResources.has(resource_uid))
			return;
		var res=GeometryService.trackedResources.get(resource_uid);
		if(res) {
			res.AcknowledgeBy(this.clientID);
		}
	}
};

module.exports= {GeometryService};
